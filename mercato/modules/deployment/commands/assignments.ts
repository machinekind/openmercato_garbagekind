import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandBus, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { mayRunPolicy } from '../../fleet/lib/lifecycle'
import { mayBeDeployed } from '../../policy_registry/lib/compatibility'
import { Assignment, Lease, StateReport, type DesiredState, type LeaseExpiryBehavior } from '../data/entities'
import { leaseSecondsFor, reconcile, renewAfterSeconds } from '../lib/lease'
import { leasePayload } from '../lib/protocol'
import { selectUsableKeys, verifyPayloadSignature } from '../../edge/lib/crypto'
import { emitDeploymentEvent } from '../events'

/**
 * Komendy kanału stanu pożądanego.
 *
 * Importujemy `mayRunPolicy` z `fleet` i `mayBeDeployed` z `policy_registry`
 * zamiast powtarzać tu warunki. To są **pliki czystych funkcji**, bez encji —
 * import klasy encji z obcego modułu skończyłby się podwójną rejestracją
 * metadanych MikroORM. Powtórzenie reguły lokalnie było kuszące i odrzucone:
 * dwa moduły z dwiema wersjami tej samej prawdy w końcu się rozjeżdżają,
 * a rozjazd akurat tej prawdy oznacza robota pracującego na wycofanej polityce.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

export const assignSchema = scoped.extend({
  robotId: z.string().uuid(),
  policyVersionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  desiredState: z.enum(['running', 'stopped']).default('running'),
  /**
   * Świadome dopuszczenie robota, który nie jest jeszcze w ruchu.
   *
   * Nie jest to „pomiń kontrolę": bramka cyklu życia i tak musi przepuścić,
   * a wartość ląduje w powodzie przypisania. Istnieje, bo tryb cieniowy
   * fazy 4 potrzebuje przypisania na maszynie w stanie `ready`.
   */
  allowNonOperational: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const revokeSchema = scoped.extend({
  assignmentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const leaseRequestSchema = z.object({
  organizationId: z.string().uuid(),
  agentSessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().min(1),
  signature: z.string().min(1),
})

export const reportSchema = z.object({
  organizationId: z.string().uuid(),
  agentSessionId: z.string().uuid(),
  reportedState: z.enum(['running', 'stopped']),
  reportedPolicyVersionId: z.string().uuid().nullable().optional(),
})

export type AssignInput = z.infer<typeof assignSchema>
export type RevokeInput = z.infer<typeof revokeSchema>
export type LeaseRequestInput = z.infer<typeof leaseRequestSchema>
export type ReportInput = z.infer<typeof reportSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

type RobotRow = {
  id: string
  tenant_id: string
  organization_id: string
  state: string
  serial_number: string
  embodiment_revision_id: string
  cell_id: string | null
  risk_class: string | null
  cell_class: string | null
}

async function loadRobot(em: EntityManager, robotId: string, tenantId: string): Promise<RobotRow | null> {
  const rows = await em.getConnection().execute<RobotRow[]>(
    `select r.id, r.tenant_id, r.organization_id, r.state, r.serial_number,
            r.embodiment_revision_id, r.cell_id, c.risk_class, c.cell_class
       from fleet_robots r
       left join fleet_cells c on c.id = r.cell_id
      where r.id = ? and r.tenant_id = ? and r.deleted_at is null
      limit 1`,
    [robotId, tenantId],
  )
  return rows?.length ? rows[0] : null
}

type VersionRow = {
  id: string
  status: string
  content_digest: string
  embodiment_revision_id: string
  policy_key: string
  version: number
  lease_expiry_behavior: LeaseExpiryBehavior | null
}

async function loadVersion(em: EntityManager, versionId: string, tenantId: string): Promise<VersionRow | null> {
  const rows = await em.getConnection().execute<VersionRow[]>(
    `select v.id, v.status, v.content_digest, v.embodiment_revision_id, v.lease_expiry_behavior, p.policy_key, v.version
       from policy_registry_policy_versions v
       join policy_registry_policies p on p.id = v.policy_id
      where v.id = ? and v.tenant_id = ?
      limit 1`,
    [versionId, tenantId],
  )
  return rows?.length ? rows[0] : null
}

const assignCommand: CommandHandler<
  AssignInput,
  { assignmentId: string; riskClass: string; leaseSeconds: number; supersededId: string | null }
> = {
  id: 'deployment.assignments.assign',
  async execute(rawInput, ctx) {
    const input = assignSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const robot = await loadRobot(em, input.robotId, input.tenantId)
    if (!robot) throw new Error(`Robot ${input.robotId} nie istnieje w tym tenancie.`)

    if (!input.allowNonOperational && !mayRunPolicy(robot.state as never)) {
      throw new Error(
        `Robot ${robot.serial_number} jest w stanie ${robot.state} — przypisanie polityki wymaga stanu operational.`,
      )
    }

    const version = await loadVersion(em, input.policyVersionId, input.tenantId)
    if (!version) throw new Error(`Wersja polityki ${input.policyVersionId} nie istnieje.`)
    if (!mayBeDeployed(version.status)) {
      throw new Error(
        `Wersja ${version.policy_key} v${version.version} ma status ${version.status} — wdrożyć da się wyłącznie wersję wypuszczoną.`,
      )
    }
    if (!version.lease_expiry_behavior) {
      throw new Error(
        `Wersja ${version.policy_key} v${version.version} nie deklaruje zachowania po wygaśnięciu dzierżawy.`,
      )
    }

    /**
     * Zgodność sprzętu sprawdzana **ponownie**, mimo że rejestr polityk już ją
     * sprawdził przy rejestracji wersji.
     *
     * To nie jest podwójna praca: tam pytaniem było „czy te wagi pasują do tej
     * rewizji", tutaj „czy ten konkretny robot jest tej rewizji". Robot bywa
     * modernizowany — wymiana chwytaka podnosi rewizję embodimentu i wersja,
     * która wczoraj była zgodna, dziś nie jest.
     */
    if (robot.embodiment_revision_id !== version.embodiment_revision_id) {
      throw new Error(
        `Robot ${robot.serial_number} jest innej rewizji embodimentu niż wersja polityki — wersja była uczona pod inny sprzęt.`,
      )
    }

    if (!robot.cell_id || !robot.risk_class) {
      // Bez celi nie ma klasy ryzyka, a bez klasy ryzyka nie ma długości
      // dzierżawy. Przypisanie z domyślną długością byłoby zgadywaniem, jak
      // długo wolno tej maszynie pracować bez nadzoru.
      throw new Error(
        `Robot ${robot.serial_number} nie stoi w żadnej celi — nie da się wyznaczyć klasy ryzyka ani długości dzierżawy.`,
      )
    }

    const riskClass = robot.risk_class
    const leaseSeconds = leaseSecondsFor(riskClass)

    /**
     * Brama dopuszczenia bezpieczeństwa — dodana przy fazie 5.
     *
     * Kierunek zależności jest tu odwrotny do intuicyjnego: to `deployment`
     * woła `safety`, a nie odwrotnie. Wariant z subskrybentem zdarzeń, który
     * odwołuje przypisanie po fakcie, wygląda czyściej — moduł bezpieczeństwa
     * nie jest wtedy zależnością kanału stanu pożądanego — i został odrzucony,
     * bo zostawia okno, w którym robot pracuje niedopuszczoną polityką,
     * a długość tego okna zależy od opóźnienia kolejki. Dopuszczenie jest
     * warunkiem wstępnym przypisania, nie jego skutkiem ubocznym.
     *
     * `allowNonOperational` **nie** omija tej bramy. Tryb cieniowy dotyczy
     * stanu robota, nie dopuszczenia polityki do klasy celi.
     */
    const bus = ctx.container.resolve('commandBus') as CommandBus
    const clearance = (
      await bus.execute('safety.clearance.check', {
        input: {
          organizationId: input.organizationId,
          tenantId: input.tenantId,
          policyVersionId: input.policyVersionId,
          cellClass: robot.cell_class ?? '',
          riskClass,
        },
        ctx,
      })
    ).result as { cleared?: boolean; reasons?: string[] }

    if (!clearance?.cleared) {
      throw new Error(
        `Wersja ${version.policy_key} v${version.version} nie jest dopuszczona do klasy celi ${robot.cell_class ?? '(brak)'}: ` +
          `${(clearance?.reasons ?? ['brak odpowiedzi warstwy bezpieczeństwa']).join('; ')}.`,
      )
    }

    // Poprzednie czynne przypisanie odchodzi w historię, nie znika.
    const previous = (await em.findOne(Assignment, {
      tenantId: input.tenantId,
      robotId: input.robotId,
      supersededAt: null,
      revokedAt: null,
    } as never)) as unknown as { id: string; supersededAt?: Date | null } | null

    if (previous) {
      /**
       * Osobny zrzut **przed** wstawieniem nowego przypisania.
       *
       * Unikat częściowy `(tenant_id, robot_id) where superseded_at is null`
       * jest sprawdzany przy każdym wierszu, a nie na końcu transakcji.
       * W jednym zrzucie MikroORM potrafi wykonać INSERT przed UPDATE i wtedy
       * przez moment istnieją dwa czynne przypisania tego samego ramienia —
       * baza odmawia i ma rację. To jest ten sam rodzaj pułapki, co czytanie
       * `id` przed `flush()`: kod wygląda poprawnie i wywala się na bazie.
       */
      previous.supersededAt = new Date()
      await em.flush()
    }

    const assignment = em.create(Assignment, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      policyVersionId: input.policyVersionId,
      policyContentDigest: version.content_digest,
      cellId: robot.cell_id,
      riskClass,
      leaseSeconds,
      leaseExpiryBehavior: version.lease_expiry_behavior,
      desiredState: input.desiredState as DesiredState,
      reason: input.reason,
      assignedBy: ctx.auth?.sub ?? null,
      metadata: input.metadata ?? null,
    } as never)

    em.persist(assignment)
    await em.flush()

    const assignmentId = (assignment as unknown as { id: string }).id
    await emitDeploymentEvent('deployment.assignment.assigned', {
      id: assignmentId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      policyVersionId: input.policyVersionId,
      desiredState: input.desiredState,
      riskClass,
      leaseSeconds,
      leaseExpiryBehavior: version.lease_expiry_behavior,
      supersededId: previous?.id ?? null,
      reason: input.reason,
    })

    return {
      assignmentId,
      riskClass,
      leaseSeconds,
      supersededId: previous?.id ?? null,
    }
  },
}

const revokeCommand: CommandHandler<RevokeInput, { assignmentId: string; revokedLeases: number }> = {
  id: 'deployment.assignments.revoke',
  async execute(rawInput, ctx) {
    const input = revokeSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const assignment = (await em.findOne(Assignment, {
      id: input.assignmentId,
      tenantId: input.tenantId,
    } as never)) as unknown as { id: string; revokedAt?: Date | null; revokedReason?: string | null } | null
    if (!assignment) throw new Error(`Przypisanie ${input.assignmentId} nie istnieje.`)
    if (assignment.revokedAt) throw new Error('Przypisanie jest już odwołane.')

    assignment.revokedAt = new Date()
    assignment.revokedReason = input.reason

    /**
     * Odwołanie dzierżaw jest **uzupełnieniem**, a nie mechanizmem zatrzymania.
     *
     * Robot bez łącza nie dowie się o odwołaniu i będzie pracował do końca
     * mandatu — i to jest projekt, nie luka. Zatrzymanie natychmiastowe należy
     * do deterministycznej warstwy bezpieczeństwa, która nie przechodzi przez
     * tę platformę. Tutaj skracamy wyłącznie ten czas, do którego sięga łącze,
     * a w celi publicznej i tak jest to najwyżej dwie minuty.
     */
    const revoked = await em.getConnection().execute<{ rowCount?: number }>(
      `update deployment_leases set revoked_at = now()
        where assignment_id = ? and tenant_id = ? and revoked_at is null and expires_at > now()`,
      [input.assignmentId, input.tenantId],
    )

    await em.flush()

    const count = Array.isArray(revoked) ? revoked.length : Number(revoked?.rowCount ?? 0)

    await emitDeploymentEvent('deployment.assignment.revoked', {
      id: assignment.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      reason: input.reason,
      revokedLeases: count,
    })

    return { assignmentId: assignment.id, revokedLeases: count }
  },
}

type SessionRow = {
  session_id: string
  agent_id: string
  robot_id: string
  tenant_id: string
  organization_id: string
  ended_at: string | null
  agent_status: string
}

/**
 * Wydanie dzierżawy na żądanie agenta.
 *
 * Uwierzytelnienie jest własnym podpisem z własnym przedrostkiem, ale
 * weryfikowanym kluczem z modułu `edge` — bo tożsamość agenta mieszka tam
 * i ma tam zostać. Odrzucona alternatywa: dopiąć stan pożądany do odpowiedzi
 * heartbeatu. Odrzucona, bo zrobiłaby z żywotności warunek wdrożenia i
 * odwrotnie: agent, który przestałby bić serce, straciłby mandat natychmiast,
 * niezależnie od klasy ryzyka celi — czyli dokładnie to, czemu dzierżawa
 * ma zapobiegać w celi ogrodzonej.
 */
const issueLeaseCommand: CommandHandler<
  LeaseRequestInput,
  {
    desiredState: DesiredState
    policyVersionId: string | null
    policyContentDigest: string | null
    leaseSeconds: number
    expiresAt: string
    renewAfterSeconds: number
    riskClass: string | null
    leaseExpiryBehavior: LeaseExpiryBehavior | null
  }
> = {
  id: 'deployment.leases.issue',
  async execute(rawInput, ctx) {
    const input = leaseRequestSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const sessions = await em.getConnection().execute<SessionRow[]>(
      `select s.id as session_id, s.agent_id, a.robot_id, a.tenant_id, a.organization_id,
              s.ended_at, a.status as agent_status
         from edge_agent_sessions s
         join edge_agents a on a.id = s.agent_id
        where s.id = ?
        limit 1`,
      [input.agentSessionId],
    )
    if (!sessions?.length) throw new Error('Nie rozpoznano sesji agenta.')
    const session = sessions[0]

    if (session.ended_at) throw new Error('Sesja agenta jest zamknięta — połącz się na nowo.')
    if (session.agent_status !== 'enrolled') throw new Error('Agent jest odwołany.')

    const keys = await em.getConnection().execute<Array<{
      public_key: string
      active_from: string
      active_until: string | null
      revoked_at: string | null
    }>>(
      `select public_key, active_from, active_until, revoked_at
         from edge_agent_keys where agent_id = ?`,
      [session.agent_id],
    )

    const usable = selectUsableKeys(
      keys.map((key) => ({
        publicKey: key.public_key,
        activeFrom: new Date(key.active_from),
        activeUntil: key.active_until ? new Date(key.active_until) : null,
        revokedAt: key.revoked_at ? new Date(key.revoked_at) : null,
      })),
    )

    const payload = leasePayload(input.agentSessionId, input.sequence, input.timestamp)
    const verified = usable.some((key) => verifyPayloadSignature(payload, input.signature, key.publicKey))
    if (!verified) {
      throw new Error('Podpis żądania dzierżawy nie zgadza się z żadnym ważnym kluczem agenta.')
    }

    // Licznik kolejny per sesja — ta sama zasada, co w kanale brzegowym.
    const last = await em.getConnection().execute<Array<{ max: number | null }>>(
      `select max(sequence) as max from deployment_leases where agent_session_id = ?`,
      [input.agentSessionId],
    )
    const lastSequence = Number(last?.[0]?.max ?? 0)
    if (input.sequence <= lastSequence) {
      throw new Error(
        `Numer kolejny ${input.sequence} nie jest większy od ostatniego (${lastSequence}) — powtórka lub klon.`,
      )
    }

    const assignment = (await em.findOne(Assignment, {
      tenantId: session.tenant_id,
      robotId: session.robot_id,
      supersededAt: null,
      revokedAt: null,
    } as never)) as unknown as {
      id: string
      policyVersionId: string
      policyContentDigest: string
      desiredState: DesiredState
      riskClass: string
      leaseSeconds: number
      leaseExpiryBehavior: LeaseExpiryBehavior
    } | null

    if (!assignment) {
      /**
       * Brak przypisania nie jest błędem — jest odpowiedzią „stój".
       *
       * 200 z `desiredState: stopped`, a nie 404: agent ma z tego wyciągnąć
       * jeden wniosek (nie pracuj), a nie wejść w pętlę ponawiania jak przy
       * awarii. Robot bez przypisania to normalny stan świeżo uruchomionej
       * maszyny.
       */
      return {
        desiredState: 'stopped' as DesiredState,
        policyVersionId: null,
        policyContentDigest: null,
        leaseSeconds: 0,
        expiresAt: new Date().toISOString(),
        renewAfterSeconds: 30,
        riskClass: null,
        leaseExpiryBehavior: null,
      }
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + assignment.leaseSeconds * 1000)

    em.persist(
      em.create(Lease, {
        organizationId: session.organization_id,
        tenantId: session.tenant_id,
        assignmentId: assignment.id,
        robotId: session.robot_id,
        agentSessionId: input.agentSessionId,
        sequence: input.sequence,
        issuedAt: now,
        expiresAt,
        leaseSeconds: assignment.leaseSeconds,
      } as never),
    )
    await em.flush()

    return {
      desiredState: assignment.desiredState,
      policyVersionId: assignment.policyVersionId,
      policyContentDigest: assignment.policyContentDigest,
      leaseSeconds: assignment.leaseSeconds,
      expiresAt: expiresAt.toISOString(),
      renewAfterSeconds: renewAfterSeconds(assignment.leaseSeconds),
      riskClass: assignment.riskClass,
      leaseExpiryBehavior: assignment.leaseExpiryBehavior,
    }
  },
}

const reportCommand: CommandHandler<ReportInput, { reconciliation: string; reason: string }> = {
  id: 'deployment.reports.record',
  async execute(rawInput, ctx) {
    const input = reportSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const sessions = await em.getConnection().execute<SessionRow[]>(
      `select s.id as session_id, s.agent_id, a.robot_id, a.tenant_id, a.organization_id,
              s.ended_at, a.status as agent_status
         from edge_agent_sessions s
         join edge_agents a on a.id = s.agent_id
        where s.id = ? limit 1`,
      [input.agentSessionId],
    )
    if (!sessions?.length) throw new Error('Nie rozpoznano sesji agenta.')
    const session = sessions[0]

    const assignment = (await em.findOne(Assignment, {
      tenantId: session.tenant_id,
      robotId: session.robot_id,
      supersededAt: null,
      revokedAt: null,
    } as never)) as unknown as {
      id: string
      policyVersionId: string
      desiredState: DesiredState
    } | null

    const verdict = assignment
      ? reconcile({
          desiredPolicyVersionId: assignment.policyVersionId,
          desiredState: assignment.desiredState,
          reportedPolicyVersionId: input.reportedPolicyVersionId ?? null,
          reportedState: input.reportedState,
        })
      : {
          state: input.reportedState === 'stopped' ? ('converged' as const) : ('drift' as const),
          reason:
            input.reportedState === 'stopped'
              ? 'brak przypisania i robot stoi — zgodnie'
              : 'robot pracuje mimo braku przypisania',
        }

    /*
     * Werdykt poprzedniego raportu tej maszyny — odczytany **przed** zapisem
     * bieżącego, bo po zapisie „poprzedni" byłby już tym właśnie.
     *
     * To jest cały mechanizm wyzwalania zboczem. Raporty przychodzą
     * z częstotliwością maszynową i rozjazd trwa tyle, ile trwa jego przyczyna;
     * ogłaszanie go przy każdym raporcie zamieniłoby zdarzenie w szum, a szum
     * jest dokładnie tym, czego operator nie czyta. `null` znaczy „pierwszy
     * raport tej maszyny" i jest traktowany jak zmiana — bo nim jest.
     */
    const poprzedni = (await em.find(
      StateReport,
      { tenantId: session.tenant_id, robotId: session.robot_id } as never,
      { orderBy: { reportedAt: 'desc' }, limit: 1 } as never,
    )) as unknown as Array<{ reconciliation: string }>
    const poprzedniWerdykt = poprzedni[0]?.reconciliation ?? null

    const report = em.create(StateReport, {
      organizationId: session.organization_id,
      tenantId: session.tenant_id,
      robotId: session.robot_id,
      assignmentId: assignment?.id ?? null,
      reportedPolicyVersionId: input.reportedPolicyVersionId ?? null,
      reportedState: input.reportedState,
      reconciliation: verdict.state,
      reason: verdict.reason,
    } as never)
    em.persist(report)
    await em.flush()

    if (verdict.state !== poprzedniWerdykt) {
      const reportId = (report as unknown as { id: string }).id
      const wspólne = {
        id: reportId,
        organizationId: session.organization_id,
        tenantId: session.tenant_id,
        robotId: session.robot_id,
        assignmentId: assignment?.id ?? null,
        reportedState: input.reportedState,
        previousReconciliation: poprzedniWerdykt,
      }
      if (verdict.state === 'drift') {
        await emitDeploymentEvent('deployment.state.drift_detected', {
          ...wspólne,
          reportedPolicyVersionId: input.reportedPolicyVersionId ?? null,
          reason: verdict.reason,
        })
      } else if (verdict.state === 'converged') {
        await emitDeploymentEvent('deployment.state.converged', wspólne)
      }
    }

    return { reconciliation: verdict.state, reason: verdict.reason }
  },
}

registerCommand(assignCommand)
registerCommand(revokeCommand)
registerCommand(issueLeaseCommand)
registerCommand(reportCommand)

export { assignCommand, revokeCommand, issueLeaseCommand, reportCommand }

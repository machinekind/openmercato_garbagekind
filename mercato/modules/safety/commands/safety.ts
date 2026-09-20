import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { EvalRun, EvalSuite, Incident, SafetyCase, type SafetyCaseStatus } from '../data/entities'
import {
  classifyIncident,
  evaluateClearance,
  type ClearanceVerdict,
  type RiskClass,
} from '../lib/clearance'
import { emitSafetyEvent } from '../events'

/**
 * Komendy warstwy bezpieczeństwa.
 *
 * `safety.clearance.check` jest komendą **odczytu** i to jest odstępstwo warte
 * nazwania. Zwykle odczyt idzie zapytaniem, nie szyną. Tutaj idzie szyną,
 * bo dopuszczenie ma zostawiać ślad w dzienniku audytu na równi z zapisem:
 * pytanie „czy wolno wdrożyć tę wersję w tej klasie celi" jest pytaniem,
 * na które trzeba umieć odpowiedzieć po trzech latach, razem z datą i aktorem.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

const riskClasses = ['fenced', 'shared', 'public'] as const
const harms = ['none', 'near_miss', 'first_aid', 'lost_time', 'serious'] as const

/**
 * Deterministyczne mechanizmy zatrzymania - słownik zamknięty.
 *
 * Każda pozycja działa bez udziału wyuczonego modelu i bez zależności od tego,
 * co robi polityka. Czego tu celowo nie ma: cokolwiek realizowanego przez
 * sieć neuronową, przez współdzieloną maszynę obliczeniową albo przez usługę
 * po sieci. Nie jest to lista preferencji - to jest granica, poza którą
 * uzasadnienia nie da się zapisać.
 */
const SAFETY_LAYER_KINDS = [
  'hardware_estop',
  'safety_plc',
  'safety_rated_torque_limit',
  'safety_rated_speed_limit',
  'light_curtain',
  'fence_interlock',
  'dual_channel_relay',
] as const

export const caseDraftSchema = scoped.extend({
  policyVersionId: z.string().uuid(),
  cellClass: z.string().trim().min(1).max(120),
  riskClass: z.enum(riskClasses),
  hazards: z.array(z.record(z.string(), z.unknown())).optional(),
  standards: z.array(z.string().trim().min(1).max(191)).optional(),
  safetyLayer: z.string().trim().max(2000).optional(),
  /** Rodzaj mechanizmu; opis w `safetyLayer` zostaje, ale sam nie wystarcza. */
  safetyLayerKind: z.enum(SAFETY_LAYER_KINDS).optional(),
  /**
   * Deklaracja polityki jako funkcji bezpieczeństwa.
   *
   * Domyślnie fałsz i domyślnie ma tak zostać. Pole istnieje, żeby próba
   * ustawienia go na prawdę była jawną, zapisaną decyzją.
   */
  declaredAsSafetyFunction: z.boolean().default(false),
})

export const caseApproveSchema = scoped.extend({
  safetyCaseId: z.string().uuid(),
  approvedBy: z.string().uuid(),
  validUntil: z.coerce.date(),
})

export const caseWithdrawSchema = scoped.extend({
  safetyCaseId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const suiteDefineSchema = scoped.extend({
  suiteKey: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(191),
  description: z.string().trim().max(2000).optional(),
  requiredFor: z.array(z.enum(riskClasses)).min(1),
  caseCount: z.number().int().positive().optional(),
})

export const runRecordSchema = scoped.extend({
  policyVersionId: z.string().uuid(),
  suiteKey: z.string().trim().min(1).max(120),
  result: z.enum(['pass', 'fail', 'error']),
  ranAt: z.coerce.date(),
  passedCases: z.number().int().nonnegative().optional(),
  totalCases: z.number().int().nonnegative().optional(),
  embodimentSpecDigest: z.string().trim().max(255).optional(),
  evidenceUri: z.string().trim().max(1000).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const clearanceSchema = scoped.extend({
  policyVersionId: z.string().uuid(),
  cellClass: z.string().trim().min(1).max(120),
  riskClass: z.enum(riskClasses),
})

export const incidentSchema = scoped.extend({
  robotId: z.string().uuid().nullable().optional(),
  cellId: z.string().uuid().nullable().optional(),
  policyVersionId: z.string().uuid().nullable().optional(),
  episodeId: z.string().uuid().nullable().optional(),
  harm: z.enum(harms),
  safetyLayerEngaged: z.boolean().default(false),
  policyImplicated: z.boolean().default(false),
  description: z.string().trim().min(1).max(2000),
  occurredAt: z.coerce.date(),
})

export type CaseDraftInput = z.infer<typeof caseDraftSchema>
export type CaseApproveInput = z.infer<typeof caseApproveSchema>
export type RunRecordInput = z.infer<typeof runRecordSchema>
export type ClearanceInput = z.infer<typeof clearanceSchema>
export type IncidentInput = z.infer<typeof incidentSchema>

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

const draftCaseCommand: CommandHandler<CaseDraftInput, { safetyCaseId: string }> = {
  id: 'safety.cases.draft',
  async execute(rawInput, ctx) {
    const input = caseDraftSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const existing = (await em.findOne(SafetyCase, {
      tenantId: input.tenantId,
      policyVersionId: input.policyVersionId,
      cellClass: input.cellClass,
    } as never)) as unknown as {
      id: string
      status: SafetyCaseStatus
      riskClass: string
      declaredAsSafetyFunction: boolean
      hazards?: unknown
      standards?: unknown
      safetyLayer?: string | null
      safetyLayerKind?: string | null
      approvedBy?: string | null
      approvedAt?: Date | null
      validUntil?: Date | null
      withdrawnReason?: string | null
    } | null

    if (existing && existing.status !== 'withdrawn') {
      throw new Error(
        `Uzasadnienie dla tej wersji polityki i klasy celi ${input.cellClass} już istnieje - wycofaj je, zamiast zakładać drugie.`,
      )
    }

    if (existing) {
      /**
       * Uzasadnienie wycofane wraca do wersji roboczej zamiast rodzić drugi wiersz.
       *
       * Unikat `(tenant, wersja, klasa celi)` jest celowy: dwa uzasadnienia dla
       * tej samej pary to dwa dokumenty, z których jeden na pewno jest
       * nieaktualny, a przy odczycie nie wiadomo który. Drugi obieg tej samej
       * pary - po wycofaniu i poprawkach - jest normalną ścieżką i ma działać,
       * więc rekord wraca do `draft` z wyczyszczonym podpisem. Zatwierdzenie
       * trzeba złożyć od nowa; to jest właściwa cena poprawki.
       */
      existing.status = 'draft'
      existing.riskClass = input.riskClass
      existing.declaredAsSafetyFunction = input.declaredAsSafetyFunction
      existing.hazards = input.hazards ?? null
      existing.standards = input.standards ?? null
      existing.safetyLayer = input.safetyLayer ?? null
      existing.safetyLayerKind = input.safetyLayerKind ?? null
      existing.approvedBy = null
      existing.approvedAt = null
      existing.validUntil = null
      existing.withdrawnReason = null
      await em.flush()
      return { safetyCaseId: existing.id }
    }

    const safetyCase = em.create(SafetyCase, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyVersionId: input.policyVersionId,
      cellClass: input.cellClass,
      riskClass: input.riskClass,
      status: 'draft' as SafetyCaseStatus,
      declaredAsSafetyFunction: input.declaredAsSafetyFunction,
      hazards: input.hazards ?? null,
      standards: input.standards ?? null,
      safetyLayer: input.safetyLayer ?? null,
      safetyLayerKind: input.safetyLayerKind ?? null,
    } as never)

    em.persist(safetyCase)
    await em.flush()

    const safetyCaseId = (safetyCase as unknown as { id: string }).id
    await emitSafetyEvent('safety.case.drafted', {
      id: safetyCaseId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyVersionId: input.policyVersionId,
      cellClass: input.cellClass,
      riskClass: input.riskClass,
    })

    return { safetyCaseId }
  },
}

const approveCaseCommand: CommandHandler<CaseApproveInput, { safetyCaseId: string; validUntil: Date }> = {
  id: 'safety.cases.approve',
  async execute(rawInput, ctx) {
    const input = caseApproveSchema.parse(rawInput ?? {})
    if (input.validUntil.getTime() <= Date.now()) {
      throw new Error('Data ważności uzasadnienia musi być w przyszłości.')
    }

    const em = resolveEm(ctx)
    const safetyCase = (await em.findOne(SafetyCase, {
      id: input.safetyCaseId,
      tenantId: input.tenantId,
    } as never)) as unknown as {
      id: string
      status: SafetyCaseStatus
      safetyLayer?: string | null
      safetyLayerKind?: string | null
      declaredAsSafetyFunction: boolean
      approvedBy?: string | null
      approvedAt?: Date | null
      validUntil?: Date | null
    } | null
    if (!safetyCase) throw new Error(`Uzasadnienie ${input.safetyCaseId} nie istnieje.`)
    if (safetyCase.status !== 'draft') {
      throw new Error(`Uzasadnienie jest w stanie ${safetyCase.status} - zatwierdzić da się wyłącznie wersję roboczą.`)
    }

    if (safetyCase.declaredAsSafetyFunction) {
      /**
       * Odmowa na poziomie zatwierdzenia, a nie dopiero przy dopuszczeniu.
       *
       * Zatwierdzone uzasadnienie, które deklaruje uczoną politykę jako
       * funkcję bezpieczeństwa, jest dokumentem wprowadzającym w błąd -
       * i w postępowaniu przed organem nadzoru szkodzi bardziej niż jego brak.
       */
      throw new Error(
        'Uzasadnienie deklaruje uczoną politykę jako funkcję bezpieczeństwa. Nie da się tego zatwierdzić: ' +
          'wpycha maszynę w Annex I część A rozporządzenia 2023/1230, czyli w ocenę przez jednostkę notyfikowaną, ' +
          'dla której nie istnieje ustalona metoda wykazania zgodności. Bezpieczeństwo egzekwuje osobna warstwa deterministyczna.',
      )
    }

    if (!safetyCase.safetyLayer || !safetyCase.safetyLayer.trim()) {
      // Uzasadnienie, które nie mówi, CO zatrzyma maszynę, gdy polityka
      // zawiedzie, nie jest uzasadnieniem - jest opisem nadziei.
      throw new Error('Uzasadnienie nie wskazuje deterministycznej warstwy bezpieczeństwa (pole safetyLayer).')
    }

    if (!safetyCase.safetyLayerKind) {
      /*
       * Sam opis nie wystarcza i nie wystarczał nigdy - tyle że do tej pory
       * nie było tego jak sprawdzić. Wolny tekst przyjmuje zdanie „warstwą
       * bezpieczeństwa jest model nadzorczy na węźle obliczeniowym", które
       * brzmi poważnie i nie jest warstwą bezpieczeństwa.
       */
      throw new Error(
        'Uzasadnienie nie podaje rodzaju warstwy bezpieczeństwa (pole safetyLayerKind). ' +
          `Dopuszczone mechanizmy deterministyczne: ${SAFETY_LAYER_KINDS.join(', ')}. ` +
          'Wyuczony model ani węzeł obliczeniowy ogólnego przeznaczenia nie są żadnym z nich.',
      )
    }

    safetyCase.status = 'approved'
    safetyCase.approvedBy = input.approvedBy
    safetyCase.approvedAt = new Date()
    safetyCase.validUntil = input.validUntil
    await em.flush()

    await emitSafetyEvent('safety.case.approved', {
      id: safetyCase.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      approvedBy: input.approvedBy,
      validUntil: input.validUntil.toISOString(),
      // Rodzaj warstwy jedzie w ładunku, bo to jest jedyna rzecz, która
      // odróżnia dopuszczenie od dokumentu opisującego nadzieję.
      safetyLayerKind: safetyCase.safetyLayerKind as string,
    })

    return { safetyCaseId: safetyCase.id, validUntil: input.validUntil }
  },
}

const withdrawCaseCommand: CommandHandler<z.infer<typeof caseWithdrawSchema>, { safetyCaseId: string }> = {
  id: 'safety.cases.withdraw',
  async execute(rawInput, ctx) {
    const input = caseWithdrawSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const safetyCase = (await em.findOne(SafetyCase, {
      id: input.safetyCaseId,
      tenantId: input.tenantId,
    } as never)) as unknown as {
      id: string
      status: SafetyCaseStatus
      withdrawnReason?: string | null
    } | null
    if (!safetyCase) throw new Error(`Uzasadnienie ${input.safetyCaseId} nie istnieje.`)
    if (safetyCase.status === 'withdrawn') throw new Error('Uzasadnienie jest już wycofane.')

    const previousStatus = safetyCase.status
    safetyCase.status = 'withdrawn'
    safetyCase.withdrawnReason = input.reason
    await em.flush()

    await emitSafetyEvent('safety.case.withdrawn', {
      id: safetyCase.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      reason: input.reason,
      previousStatus,
    })

    return { safetyCaseId: safetyCase.id }
  },
}

const defineSuiteCommand: CommandHandler<z.infer<typeof suiteDefineSchema>, { suiteId: string }> = {
  id: 'safety.suites.define',
  async execute(rawInput, ctx) {
    const input = suiteDefineSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const existing = (await em.findOne(EvalSuite, {
      tenantId: input.tenantId,
      suiteKey: input.suiteKey,
    } as never)) as unknown as {
      id: string
      name: string
      description?: string | null
      requiredFor: string[]
      caseCount?: number | null
    } | null

    if (existing) {
      // Katalog zestawów jest konfiguracją, nie księgą: aktualizacja w miejscu
      // jest tu poprawna. To jedyne miejsce w całym projekcie, gdzie nadpisanie
      // jest właściwym zachowaniem - i dlatego jest opisane.
      existing.name = input.name
      existing.description = input.description ?? null
      existing.requiredFor = input.requiredFor
      existing.caseCount = input.caseCount ?? null
      await em.flush()
      return { suiteId: existing.id }
    }

    const suite = em.create(EvalSuite, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      suiteKey: input.suiteKey,
      name: input.name,
      description: input.description ?? null,
      requiredFor: input.requiredFor,
      caseCount: input.caseCount ?? null,
    } as never)
    em.persist(suite)
    await em.flush()

    // Ścieżka nadpisania wyżej nie emituje: zestaw o tym samym kluczu to ten
    // sam zestaw, a jego redefinicja nie jest nowym faktem dla nikogo poza
    // modułem.
    const suiteId = (suite as unknown as { id: string }).id
    await emitSafetyEvent('safety.suite.defined', {
      id: suiteId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      suiteKey: input.suiteKey,
      requiredFor: input.requiredFor,
    })

    return { suiteId }
  },
}

const recordRunCommand: CommandHandler<RunRecordInput, { evalRunId: string }> = {
  id: 'safety.runs.record',
  async execute(rawInput, ctx) {
    const input = runRecordSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const suite = (await em.findOne(EvalSuite, {
      tenantId: input.tenantId,
      suiteKey: input.suiteKey,
    } as never)) as unknown as { id: string } | null
    if (!suite) throw new Error(`Zestaw ewaluacyjny ${input.suiteKey} nie jest zdefiniowany.`)

    /**
     * Odcisk kontraktu brany z wersji polityki, gdy wołający go nie podał.
     *
     * Domyślność w tę stronę jest bezpieczna: przebieg bez odcisku nie
     * zostałby odrzucony przez kontrolę zgodności sprzętu, więc lepiej wpisać
     * wartość prawdziwą niż zostawić pustą. Wołający, który zna odcisk lepiej
     * (bo testował na stanowisku), poda swój i wtedy rozjazd wyjdzie.
     */
    let digest = input.embodimentSpecDigest ?? null
    if (!digest) {
      const rows = await em.getConnection().execute<Array<{ embodiment_spec_digest: string }>>(
        `select embodiment_spec_digest from policy_registry_policy_versions where id = ? and tenant_id = ? limit 1`,
        [input.policyVersionId, input.tenantId],
      )
      digest = rows?.[0]?.embodiment_spec_digest ?? null
    }

    const run = em.create(EvalRun, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyVersionId: input.policyVersionId,
      suiteKey: input.suiteKey,
      result: input.result,
      passedCases: input.passedCases ?? null,
      totalCases: input.totalCases ?? null,
      embodimentSpecDigest: digest,
      evidenceUri: input.evidenceUri ?? null,
      ranAt: input.ranAt,
      ranBy: ctx.auth?.sub ?? null,
      details: input.details ?? null,
    } as never)

    em.persist(run)
    await em.flush()

    const evalRunId = (run as unknown as { id: string }).id
    await emitSafetyEvent('safety.run.recorded', {
      id: evalRunId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      policyVersionId: input.policyVersionId,
      suiteKey: input.suiteKey,
      result: input.result,
      passedCases: input.passedCases ?? null,
      totalCases: input.totalCases ?? null,
      embodimentSpecDigest: digest,
    })

    if (input.result !== 'pass') {
      await emitSafetyEvent('safety.run.failed', {
        id: evalRunId,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        policyVersionId: input.policyVersionId,
        suiteKey: input.suiteKey,
        result: input.result,
        evidenceUri: input.evidenceUri ?? null,
      })
    }

    return { evalRunId }
  },
}

/**
 * Sprawdzenie dopuszczenia - czytane przez moduł wdrożeń przed przypisaniem.
 *
 * Kierunek zależności: `deployment` → `safety`. Wybrany świadomie przeciwko
 * wariantowi z subskrybentem zdarzeń, który odwoływałby przypisanie po fakcie.
 * Ten drugi wygląda czyściej (moduł bezpieczeństwa nie jest wtedy zależnością
 * kanału stanu pożądanego), ale zostawia okno, w którym robot pracuje
 * niedopuszczoną polityką - a długość tego okna zależy od opóźnienia kolejki.
 * Dopuszczenie jest warunkiem wstępnym przypisania, nie jego skutkiem ubocznym.
 */
const checkClearanceCommand: CommandHandler<ClearanceInput, ClearanceVerdict> = {
  id: 'safety.clearance.check',
  async execute(rawInput, ctx) {
    const input = clearanceSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const versionRows = await em.getConnection().execute<Array<{ embodiment_spec_digest: string }>>(
      `select embodiment_spec_digest from policy_registry_policy_versions where id = ? and tenant_id = ? limit 1`,
      [input.policyVersionId, input.tenantId],
    )

    const suiteRows = await em.getConnection().execute<Array<{ suite_key: string; required_for: string[] }>>(
      `select suite_key, required_for from safety_eval_suites where tenant_id = ?`,
      [input.tenantId],
    )

    const runRows = await em.getConnection().execute<Array<{
      suite_key: string
      policy_version_id: string
      result: string
      ran_at: string
      embodiment_spec_digest: string | null
    }>>(
      `select suite_key, policy_version_id, result, ran_at, embodiment_spec_digest
         from safety_eval_runs where tenant_id = ? and policy_version_id = ?`,
      [input.tenantId, input.policyVersionId],
    )

    const caseRows = await em.getConnection().execute<Array<{
      cell_class: string
      status: string
      policy_version_id: string
      valid_until: string | null
      declared_as_safety_function: boolean
    }>>(
      `select cell_class, status, policy_version_id, valid_until, declared_as_safety_function
         from safety_cases where tenant_id = ? and policy_version_id = ?`,
      [input.tenantId, input.policyVersionId],
    )

    return evaluateClearance({
      policyVersionId: input.policyVersionId,
      policyEmbodimentSpecDigest: versionRows?.[0]?.embodiment_spec_digest ?? null,
      cellClass: input.cellClass,
      riskClass: input.riskClass as RiskClass,
      requirements: suiteRows.map((row) => ({
        suiteKey: row.suite_key,
        requiredFor: (row.required_for ?? []) as RiskClass[],
      })),
      runs: runRows.map((row) => ({
        suiteKey: row.suite_key,
        policyVersionId: row.policy_version_id,
        result: row.result as 'pass' | 'fail' | 'error',
        ranAt: new Date(row.ran_at),
        embodimentSpecDigest: row.embodiment_spec_digest,
      })),
      safetyCases: caseRows.map((row) => ({
        cellClass: row.cell_class,
        status: row.status as SafetyCaseStatus,
        policyVersionId: row.policy_version_id,
        validUntil: row.valid_until ? new Date(row.valid_until) : null,
        declaredAsSafetyFunction: Boolean(row.declared_as_safety_function),
      })),
    })
  },
}

const reportIncidentCommand: CommandHandler<
  IncidentInput,
  { incidentId: string; priority: string; haltDeployment: boolean; reason: string }
> = {
  id: 'safety.incidents.report',
  async execute(rawInput, ctx) {
    const input = incidentSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    let cellClass: string | null = null
    if (input.cellId) {
      const rows = await em.getConnection().execute<Array<{ cell_class: string }>>(
        `select cell_class from fleet_cells where id = ? and tenant_id = ? limit 1`,
        [input.cellId, input.tenantId],
      )
      cellClass = rows?.[0]?.cell_class ?? null
    }

    const verdict = classifyIncident({
      harm: input.harm,
      safetyLayerEngaged: input.safetyLayerEngaged,
      policyImplicated: input.policyImplicated,
    })

    const incident = em.create(Incident, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId ?? null,
      cellId: input.cellId ?? null,
      cellClass,
      policyVersionId: input.policyVersionId ?? null,
      episodeId: input.episodeId ?? null,
      harm: input.harm,
      safetyLayerEngaged: input.safetyLayerEngaged,
      policyImplicated: input.policyImplicated,
      priority: verdict.priority,
      haltDeployment: verdict.haltDeployment,
      description: input.description,
      occurredAt: input.occurredAt,
      reportedBy: ctx.auth?.sub ?? null,
    } as never)

    em.persist(incident)
    await em.flush()

    /**
     * Incydent wymagający wstrzymania **wycofuje uzasadnienie** dla klasy celi.
     *
     * Nie zatrzymuje pojedynczego wdrożenia: skoro dopuszczenie dotyczy klasy
     * celi, to zdarzenie podważające je podważa je dla wszystkich cel tej
     * klasy. Wycofanie uzasadnienia sprawia, że każde kolejne przypisanie tej
     * wersji w tej klasie odbija się samo - bez wyliczania, komu ją zdjąć.
     */
    if (verdict.haltDeployment && input.policyVersionId && cellClass) {
      await em.getConnection().execute(
        `update safety_cases
            set status = 'withdrawn',
                withdrawn_reason = ?,
                updated_at = now()
          where tenant_id = ? and policy_version_id = ? and cell_class = ? and status = 'approved'`,
        [
          `Incydent: ${verdict.reason}`,
          input.tenantId,
          input.policyVersionId,
          cellClass,
        ],
      )
    }

    const incidentId = (incident as unknown as { id: string }).id
    await emitSafetyEvent('safety.incident.reported', {
      id: incidentId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId ?? null,
      cellId: input.cellId ?? null,
      policyVersionId: input.policyVersionId ?? null,
      episodeId: input.episodeId ?? null,
      harm: input.harm,
      priority: verdict.priority,
      haltDeployment: verdict.haltDeployment,
      safetyLayerEngaged: input.safetyLayerEngaged,
      policyImplicated: input.policyImplicated,
      reason: verdict.reason,
      occurredAt: input.occurredAt.toISOString(),
    })

    if (verdict.haltDeployment && input.policyVersionId && cellClass) {
      // Emitowane pod tym samym warunkiem, co wycofanie hurtowe wyżej - nie
      // pod samym `haltDeployment`. Incydent bez wskazanej wersji polityki
      // albo bez klasy celi niczego nie wycofał i ogłaszanie, że wycofał,
      // byłoby nieprawdą.
      await emitSafetyEvent('safety.incident.halted_deployment', {
        id: incidentId,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        policyVersionId: input.policyVersionId,
        cellClass,
        priority: verdict.priority,
        reason: verdict.reason,
      })
    }

    return {
      incidentId,
      priority: verdict.priority,
      haltDeployment: verdict.haltDeployment,
      reason: verdict.reason,
    }
  },
}

registerCommand(draftCaseCommand)
registerCommand(approveCaseCommand)
registerCommand(withdrawCaseCommand)
registerCommand(defineSuiteCommand)
registerCommand(recordRunCommand)
registerCommand(checkClearanceCommand)
registerCommand(reportIncidentCommand)

export {
  draftCaseCommand,
  approveCaseCommand,
  withdrawCaseCommand,
  defineSuiteCommand,
  recordRunCommand,
  checkClearanceCommand,
  reportIncidentCommand,
}

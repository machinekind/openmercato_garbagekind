import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Agent, AgentKey, AgentSession, EnrollmentToken } from '../data/entities'
import {
  assertSupportedPublicKey,
  fingerprintPublicKey,
  generateEnrollmentToken,
  hashEnrollmentToken,
  payloads,
  selectUsableKeys,
  verifyPayloadSignature,
} from '../lib/crypto'
import { evaluateLiveness, isTimestampFresh } from '../lib/liveness'
import { emitEdgeEvent } from '../events'

/**
 * Komendy kanału brzegowego.
 *
 * Wszystkie zapisy idą szyną komend — tak samo jak w rejestrze floty i z tego
 * samego powodu: w produkcie, w którym zła operacja porusza tonową maszyną,
 * „kto to zrobił i co było przedtem" jest wymaganiem, nie udogodnieniem.
 *
 * Dwie z tych komend (`enroll`, `heartbeat`) wołane są przez agenta, a nie
 * przez zalogowanego człowieka. Dlatego ich autoryzacja nie opiera się na
 * sesji użytkownika, tylko na podpisie kluczem, którego centrala nie posiada.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

/* ------------------------------------------------------------------ */
/* 1. Bilet wpisowy                                                    */
/* ------------------------------------------------------------------ */

export const issueEnrollmentSchema = scoped.extend({
  robotId: z.string().uuid(),
  /** Domyślnie godzina: bilet ma przeżyć instalację, nie wdrożenie. */
  ttlMinutes: z.number().int().min(1).max(60 * 24 * 7).default(60),
  heartbeatIntervalSeconds: z.number().int().min(1).max(3600).default(30),
  livenessGraceSeconds: z.number().int().min(0).max(3600).default(30),
  lostAfterSeconds: z.number().int().min(5).max(86_400).default(300),
})

export type IssueEnrollmentInput = z.infer<typeof issueEnrollmentSchema>

const issueEnrollmentCommand: CommandHandler<
  IssueEnrollmentInput,
  { tokenId: string; token: string; expiresAt: Date }
> = {
  id: 'edge.enrollment.issue',
  async execute(rawInput, ctx) {
    const input = issueEnrollmentSchema.parse(rawInput ?? {})
    if (input.lostAfterSeconds <= input.heartbeatIntervalSeconds + input.livenessGraceSeconds) {
      // Bez tego „utracony" nastąpiłby przed albo razem ze „spóźniony",
      // a rozdział tych stanów jest jedynym powodem, dla którego istnieją.
      throw new Error('Próg utraty musi być dłuższy niż odstęp uderzeń serca powiększony o tolerancję.')
    }

    const em = resolveEm(ctx)
    const token = generateEnrollmentToken()
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000)

    const record = em.create(EnrollmentToken, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      tokenHash: hashEnrollmentToken(token),
      expiresAt,
      issuedBy: ctx.auth?.sub ?? null,
    } as never)
    em.persist(record)
    await em.flush()

    // Parametry żywotności podróżują razem z biletem, w jawnej postaci —
    // agent musi znać swój termin, zanim po raz pierwszy się odezwie.
    const tokenId = (record as unknown as { id: string }).id
    await emitEdgeEvent('edge.enrollment.issued', {
      id: tokenId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      robotId: input.robotId,
      expiresAt: expiresAt.toISOString(),
      issuedBy: ctx.auth?.sub ?? null,
    })

    return {
      tokenId,
      // Jedyny moment, w którym jawny bilet w ogóle istnieje po stronie centrali.
      token,
      expiresAt,
      heartbeatIntervalSeconds: input.heartbeatIntervalSeconds,
      livenessGraceSeconds: input.livenessGraceSeconds,
      lostAfterSeconds: input.lostAfterSeconds,
    } as never
  },
}

/* ------------------------------------------------------------------ */
/* 2. Wpis agenta                                                      */
/* ------------------------------------------------------------------ */

export const enrollAgentSchema = z.object({
  token: z.string().min(1),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  agentKind: z.enum(['onboard', 'cell_controller', 'sim']).default('onboard'),
  agentVersion: z.string().max(120).optional(),
  heartbeatIntervalSeconds: z.number().int().min(1).max(3600).default(30),
  livenessGraceSeconds: z.number().int().min(0).max(3600).default(30),
  lostAfterSeconds: z.number().int().min(5).max(86_400).default(300),
})

export type EnrollAgentInput = z.infer<typeof enrollAgentSchema>

const enrollAgentCommand: CommandHandler<
  EnrollAgentInput,
  { agentId: string; robotId: string; sessionId: string; fingerprint: string }
> = {
  id: 'edge.agents.enroll',
  async execute(rawInput, ctx) {
    const input = enrollAgentSchema.parse(rawInput ?? {})
    assertSupportedPublicKey(input.publicKey)
    const fingerprint = fingerprintPublicKey(input.publicKey)

    /**
     * Podpis biletu **nowym kluczem** wiąże dwie rzeczy, których osobno
     * podszycie się jest łatwe: posiadanie biletu i posiadanie klucza
     * prywatnego. Bez tego przechwycony bilet pozwalałby wpisać dowolny
     * własny klucz i stać się robotem.
     */
    if (!verifyPayloadSignature(payloads.enroll(input.token, fingerprint), input.signature, input.publicKey)) {
      throw new Error('Podpis wpisu nie zgadza się z przedstawionym kluczem publicznym.')
    }

    const em = resolveEm(ctx)
    const tokenRecord = (await em.findOne(EnrollmentToken, {
      tokenHash: hashEnrollmentToken(input.token),
    } as never)) as unknown as {
      id: string
      organizationId: string
      tenantId: string
      robotId: string
      expiresAt: Date
      usedAt?: Date | null
      usedByAgentId?: string | null
    } | null

    // Ten sam komunikat dla biletu nieistniejącego i zużytego: rozróżnienie
    // powiedziałoby zgadującemu, czy trafił w istniejący bilet.
    if (!tokenRecord) throw new Error('Bilet wpisowy nieważny lub już zużyty.')
    if (tokenRecord.usedAt) throw new Error('Bilet wpisowy nieważny lub już zużyty.')
    if (tokenRecord.expiresAt.getTime() <= Date.now()) throw new Error('Bilet wpisowy wygasł.')

    const existing = await em.findOne(Agent, {
      tenantId: tokenRecord.tenantId,
      robotId: tokenRecord.robotId,
      status: 'enrolled',
    } as never)
    if (existing) {
      // Świadomie odmowa, nie ciche zastąpienie. Drugi agent na tej samej
      // maszynie to albo klon, albo nieudane wdrożenie — oba wymagają
      // decyzji człowieka, a nie automatycznego rozstrzygnięcia na korzyść
      // tego, kto odezwał się później.
      throw new Error('Robot ma już wpisanego agenta. Odwołaj poprzedniego przed wpisaniem nowego.')
    }

    const agent = em.create(Agent, {
      organizationId: tokenRecord.organizationId,
      tenantId: tokenRecord.tenantId,
      robotId: tokenRecord.robotId,
      agentKind: input.agentKind,
      agentVersion: input.agentVersion ?? null,
      status: 'enrolled',
      heartbeatIntervalSeconds: input.heartbeatIntervalSeconds,
      livenessGraceSeconds: input.livenessGraceSeconds,
      lostAfterSeconds: input.lostAfterSeconds,
      lastSeenAt: null,
    } as never)
    em.persist(agent)
    // Identyfikator nadaje Postgres, więc klucz i sesja nie mają jeszcze na co
    // wskazać — stąd zrzut pośredni. Ta sama mechanika, co przy rejestracji robota.
    await em.flush()
    const agentId = (agent as unknown as { id: string }).id

    const key = em.create(AgentKey, {
      organizationId: tokenRecord.organizationId,
      tenantId: tokenRecord.tenantId,
      agentId,
      publicKey: input.publicKey,
      fingerprint,
    } as never)
    em.persist(key)
    await em.flush()
    const keyId = (key as unknown as { id: string }).id

    const session = em.create(AgentSession, {
      organizationId: tokenRecord.organizationId,
      tenantId: tokenRecord.tenantId,
      agentId,
      keyId,
      agentVersion: input.agentVersion ?? null,
    } as never)
    em.persist(session)

    await em.nativeUpdate(
      EnrollmentToken,
      { id: tokenRecord.id },
      { usedAt: new Date(), usedByAgentId: agentId } as never,
    )
    await em.flush()

    const sessionId = (session as unknown as { id: string }).id
    await emitEdgeEvent('edge.agent.enrolled', {
      id: agentId,
      organizationId: tokenRecord.organizationId,
      tenantId: tokenRecord.tenantId,
      robotId: tokenRecord.robotId,
      sessionId,
      fingerprint,
      agentVersion: input.agentVersion ?? null,
    })

    return {
      agentId,
      robotId: tokenRecord.robotId,
      sessionId,
      fingerprint,
    }
  },
}

/* ------------------------------------------------------------------ */
/* 3. Ponowne połączenie                                               */
/* ------------------------------------------------------------------ */

export const connectAgentSchema = z.object({
  agentId: z.string().uuid(),
  timestamp: z.coerce.date(),
  signature: z.string().min(1),
  agentVersion: z.string().max(120).optional(),
})

export type ConnectAgentInput = z.infer<typeof connectAgentSchema>

const connectAgentCommand: CommandHandler<
  ConnectAgentInput,
  { sessionId: string; supersededSessionId: string | null; heartbeatIntervalSeconds: number }
> = {
  id: 'edge.agents.connect',
  async execute(rawInput, ctx) {
    const input = connectAgentSchema.parse(rawInput ?? {})
    if (!isTimestampFresh(input.timestamp)) {
      throw new Error('Znacznik czasu poza dopuszczalnym rozjazdem zegarów.')
    }

    const em = resolveEm(ctx)
    const { agent, key } = await authenticateAgent(
      em,
      input.agentId,
      payloads.connect(input.agentId, input.timestamp.toISOString()),
      input.signature,
    )

    /**
     * Poprzednia otwarta sesja jest zamykana jako „wyparta".
     *
     * To jest cały mechanizm wykrywania klonów: dwie kopie tego samego agenta
     * będą się nawzajem wypierać, a ciąg sesji `superseded` w krótkim czasie
     * jest podpisem tego zjawiska. Nie da się tego zobaczyć w kolumnie
     * „ostatnio widziany", bo klon też ją odświeża.
     */
    const open = (await em.find(AgentSession, {
      agentId: input.agentId,
      endedAt: null,
    } as never)) as unknown as Array<{
      id: string
      endedAt?: Date | null
      endedReason?: string | null
      heartbeatCount?: number | null
      lastHeartbeatAt?: Date | null
    }>

    const supersededAt = new Date()
    // Zdjęcie stanu wypartej sesji **przed** jej zamknięciem: po zapisie
    // `endedAt` nie da się już odtworzyć, jak długo milczała w chwili wyparcia,
    // a to jest jedyna liczba odróżniająca restart od drugiego nadawcy.
    const superseded = open[0]
      ? {
          id: open[0].id,
          heartbeatCount: open[0].heartbeatCount ?? 0,
          silenceSeconds: open[0].lastHeartbeatAt
            ? Math.round((supersededAt.getTime() - open[0].lastHeartbeatAt.getTime()) / 1000)
            : null,
        }
      : null

    for (const session of open) {
      session.endedAt = supersededAt
      session.endedReason = 'superseded' as never
    }

    const session = em.create(AgentSession, {
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      agentId: input.agentId,
      keyId: key.id,
      agentVersion: input.agentVersion ?? agent.agentVersion ?? null,
    } as never)
    em.persist(session)
    await em.flush()

    const sessionId = (session as unknown as { id: string }).id
    await emitEdgeEvent('edge.agent.connected', {
      id: input.agentId,
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      robotId: agent.robotId,
      sessionId,
      supersededSessionId: superseded?.id ?? null,
      agentVersion: input.agentVersion ?? agent.agentVersion ?? null,
    })

    if (superseded) {
      await emitEdgeEvent('edge.agent.clone_suspected', {
        id: input.agentId,
        organizationId: agent.organizationId,
        tenantId: agent.tenantId,
        robotId: agent.robotId,
        sessionId,
        supersededSessionId: superseded.id,
        supersededHeartbeatCount: superseded.heartbeatCount,
        supersededSilenceSeconds: superseded.silenceSeconds,
      })
    }

    return {
      sessionId,
      supersededSessionId: superseded?.id ?? null,
      heartbeatIntervalSeconds: agent.heartbeatIntervalSeconds,
    }
  },
}

/* ------------------------------------------------------------------ */
/* 4. Uderzenie serca                                                  */
/* ------------------------------------------------------------------ */

export const heartbeatSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int().min(1),
  timestamp: z.coerce.date(),
  signature: z.string().min(1),
})

export type HeartbeatInput = z.infer<typeof heartbeatSchema>

const heartbeatCommand: CommandHandler<
  HeartbeatInput,
  { agentId: string; robotId: string; sequence: number; nextDeadline: Date; state: string }
> = {
  id: 'edge.agents.heartbeat',
  async execute(rawInput, ctx) {
    const input = heartbeatSchema.parse(rawInput ?? {})
    if (!isTimestampFresh(input.timestamp)) {
      throw new Error('Znacznik czasu poza dopuszczalnym rozjazdem zegarów.')
    }

    const em = resolveEm(ctx)
    const session = (await em.findOne(AgentSession, { id: input.sessionId } as never)) as unknown as {
      id: string
      agentId: string
      lastSequence: number
      heartbeatCount: number
      lastHeartbeatAt?: Date | null
      endedAt?: Date | null
      endedReason?: string | null
    } | null

    if (!session) throw new Error('Sesja nie istnieje.')
    if (session.endedAt) {
      // Sesja wyparta albo wygaszona nie „wraca do życia" uderzeniem serca.
      // Agent ma się połączyć na nowo — i ten fakt ma zostać w historii.
      throw new Error(`Sesja zamknięta (${session.endedReason ?? 'nieznany powód'}) — wymagane ponowne połączenie.`)
    }

    if (input.sequence <= session.lastSequence) {
      // Numer niemalejący to powtórka albo drugi nadawca z tym samym kluczem.
      // Jedno i drugie jest incydentem bezpieczeństwa, nie zakłóceniem sieci.
      throw new Error(
        `Numer kolejny ${input.sequence} nie jest większy od ostatniego (${session.lastSequence}) — powtórka lub klon.`,
      )
    }

    const { agent } = await authenticateAgent(
      em,
      session.agentId,
      payloads.heartbeat(input.sessionId, input.sequence, input.timestamp.toISOString()),
      input.signature,
    )

    const now = new Date()
    session.lastSequence = input.sequence
    session.heartbeatCount = (session.heartbeatCount ?? 0) + 1
    session.lastHeartbeatAt = now

    const target = agent as unknown as { lastSeenAt?: Date | null }
    target.lastSeenAt = now
    await em.flush()

    const verdict = evaluateLiveness(
      {
        lastSeenAt: now,
        heartbeatIntervalSeconds: agent.heartbeatIntervalSeconds,
        livenessGraceSeconds: agent.livenessGraceSeconds,
        lostAfterSeconds: agent.lostAfterSeconds,
        status: 'enrolled',
      },
      now,
    )

    return {
      agentId: agent.id,
      robotId: agent.robotId,
      sequence: input.sequence,
      // Termin wraca do agenta w odpowiedzi — dzięki temu robot zna swój
      // własny czas do odcięcia i może sam zwolnić, gdy centrala zamilknie.
      nextDeadline: verdict.deadline as Date,
      state: verdict.state,
    }
  },
}

/* ------------------------------------------------------------------ */
/* 5. Rotacja klucza                                                   */
/* ------------------------------------------------------------------ */

export const rotateKeySchema = z.object({
  agentId: z.string().uuid(),
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  /** Ile minut stary klucz pozostaje ważny równolegle z nowym. */
  overlapMinutes: z.number().int().min(0).max(60 * 24).default(15),
})

export type RotateKeyInput = z.infer<typeof rotateKeySchema>

const rotateKeyCommand: CommandHandler<
  RotateKeyInput,
  { keyId: string; fingerprint: string; retiredKeyIds: string[]; overlapUntil: Date }
> = {
  id: 'edge.keys.rotate',
  async execute(rawInput, ctx) {
    const input = rotateKeySchema.parse(rawInput ?? {})
    assertSupportedPublicKey(input.publicKey)
    const fingerprint = fingerprintPublicKey(input.publicKey)

    if (!verifyPayloadSignature(payloads.rotate(input.agentId, fingerprint), input.signature, input.publicKey)) {
      throw new Error('Podpis rotacji nie zgadza się z nowym kluczem publicznym.')
    }

    const em = resolveEm(ctx)
    const agent = (await em.findOne(Agent, { id: input.agentId } as never)) as unknown as {
      id: string
      organizationId: string
      tenantId: string
      status: string
    } | null
    if (!agent) throw new Error('Agent nie istnieje.')
    if (agent.status !== 'enrolled') throw new Error('Nie da się rotować klucza agenta odwołanego.')

    const overlapUntil = new Date(Date.now() + input.overlapMinutes * 60_000)
    const current = (await em.find(AgentKey, {
      agentId: input.agentId,
      activeUntil: null,
      revokedAt: null,
    } as never)) as unknown as Array<{ id: string; activeUntil?: Date | null }>

    // Stary klucz dostaje datę końca, a nie odwołanie: między wydaniem nowego
    // a jego dotarciem na robota jest okno, w którym robot podpisuje jeszcze
    // starym. Natychmiastowe odwołanie zerwałoby łączność z całą flotą naraz.
    for (const key of current) key.activeUntil = overlapUntil

    const next = em.create(AgentKey, {
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      agentId: input.agentId,
      publicKey: input.publicKey,
      fingerprint,
    } as never)
    em.persist(next)
    await em.flush()

    const keyId = (next as unknown as { id: string }).id
    const retiredKeyIds = current.map((key) => key.id)
    await emitEdgeEvent('edge.agent.key_rotated', {
      id: keyId,
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      agentId: input.agentId,
      fingerprint,
      retiredKeyIds,
      overlapUntil: overlapUntil.toISOString(),
    })

    return {
      keyId,
      fingerprint,
      retiredKeyIds,
      overlapUntil,
    }
  },
}

/* ------------------------------------------------------------------ */
/* 6. Odwołanie agenta                                                 */
/* ------------------------------------------------------------------ */

export const revokeAgentSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export type RevokeAgentInput = z.infer<typeof revokeAgentSchema>

const revokeAgentCommand: CommandHandler<RevokeAgentInput, { agentId: string; revokedKeys: number }> = {
  id: 'edge.agents.revoke',
  async execute(rawInput, ctx) {
    const input = revokeAgentSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const agent = (await em.findOne(Agent, { id: input.agentId } as never)) as unknown as {
      id: string
      robotId: string
      organizationId: string
      tenantId: string
      status: string
      revokedAt?: Date | null
      revokedReason?: string | null
    } | null
    if (!agent) throw new Error('Agent nie istnieje.')

    const now = new Date()
    agent.status = 'revoked'
    agent.revokedAt = now
    agent.revokedReason = input.reason

    const keys = (await em.find(AgentKey, { agentId: input.agentId, revokedAt: null } as never)) as unknown as Array<{
      revokedAt?: Date | null
    }>
    // Tu odwołanie jest natychmiastowe, bez okna — bo powodem odwołania agenta
    // jest zwykle podejrzenie, że klucz jest w cudzych rękach.
    for (const key of keys) key.revokedAt = now

    const sessions = (await em.find(AgentSession, { agentId: input.agentId, endedAt: null } as never)) as unknown as Array<{
      endedAt?: Date | null
      endedReason?: string | null
    }>
    for (const session of sessions) {
      session.endedAt = now
      session.endedReason = 'revoked' as never
    }

    await em.flush()

    await emitEdgeEvent('edge.agent.revoked', {
      id: input.agentId,
      organizationId: agent.organizationId,
      tenantId: agent.tenantId,
      robotId: agent.robotId,
      reason: input.reason,
      revokedKeys: keys.length,
    })

    return { agentId: input.agentId, revokedKeys: keys.length }
  },
}

/* ------------------------------------------------------------------ */
/* 7. Zamykanie sesji po ciszy                                         */
/* ------------------------------------------------------------------ */

export const sweepSchema = scoped.partial().extend({
  tenantId: z.string().uuid(),
})

export type SweepInput = z.infer<typeof sweepSchema>

const sweepSessionsCommand: CommandHandler<
  SweepInput,
  {
    closed: number
    lost: Array<{ agentId: string; robotId: string; sessionId: string; silenceSeconds: number | null }>
  }
> = {
  id: 'edge.sessions.sweep',
  async execute(rawInput, ctx) {
    const input = sweepSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const now = new Date()

    const sessions = (await em.find(AgentSession, {
      tenantId: input.tenantId,
      endedAt: null,
    } as never)) as unknown as Array<{
      id: string
      agentId: string
      endedAt?: Date | null
      endedReason?: string | null
    }>

    const lost: Array<{
      agentId: string
      robotId: string
      sessionId: string
      organizationId: string
      tenantId: string
      silenceSeconds: number | null
    }> = []
    let closed = 0

    for (const session of sessions) {
      const agent = (await em.findOne(Agent, { id: session.agentId } as never)) as unknown as {
        id: string
        robotId: string
        organizationId: string
        tenantId: string
        status: 'enrolled' | 'revoked'
        lastSeenAt?: Date | null
        heartbeatIntervalSeconds: number
        livenessGraceSeconds: number
        lostAfterSeconds: number
      } | null
      if (!agent) continue

      const verdict = evaluateLiveness(
        {
          lastSeenAt: agent.lastSeenAt ?? null,
          heartbeatIntervalSeconds: agent.heartbeatIntervalSeconds,
          livenessGraceSeconds: agent.livenessGraceSeconds,
          lostAfterSeconds: agent.lostAfterSeconds,
          status: agent.status,
        },
        now,
      )
      if (verdict.state !== 'lost') continue

      session.endedAt = now
      session.endedReason = 'timeout' as never
      closed += 1
      lost.push({
        agentId: agent.id,
        robotId: agent.robotId,
        sessionId: session.id,
        organizationId: agent.organizationId,
        tenantId: agent.tenantId,
        silenceSeconds: verdict.silenceSeconds,
      })
    }

    /*
     * Zrzut przed emisją: zamknięcie sesji musi być trwałe, zanim ktokolwiek
     * dostanie wiadomość o utracie. Odwrotna kolejność przy awarii dałaby
     * subskrybenta, który wie o utracie, i bazę, która o niej nie wie.
     */
    await em.flush()

    for (const wpis of lost) {
      await emitEdgeEvent('edge.agent.lost', {
        id: wpis.agentId,
        organizationId: wpis.organizationId,
        tenantId: wpis.tenantId,
        robotId: wpis.robotId,
        sessionId: wpis.sessionId,
        silenceSeconds: wpis.silenceSeconds,
      })
    }

    /**
     * Zamiatanie **nie** zmienia stanu robota.
     *
     * Kusi, żeby od razu wrzucić utraconą maszynę do kwarantanny — i to jest
     * dokładnie ta granica, której ten moduł nie przekracza. `edge` stwierdza
     * ciszę; wniosek, że cisza znaczy „nie wolno pracować", należy do dziedziny
     * i zapada w `fleet`. Zwracamy więc listę, a nie wykonujemy wyroku.
     */
    return {
      closed,
      lost: lost.map(({ agentId, robotId, sessionId, silenceSeconds }) => ({
        agentId,
        robotId,
        sessionId,
        silenceSeconds,
      })),
    }
  },
}

/* ------------------------------------------------------------------ */

/**
 * Wspólne uwierzytelnienie agenta: podpis musi zgadzać się z którymś z kluczy
 * ważnych **w tej chwili**. Sprawdzamy wszystkie, bo w oknie rotacji ważne są
 * dwa — a agent nie ma jak powiedzieć, którym właśnie podpisał.
 */
export async function authenticateAgent(
  em: EntityManager,
  agentId: string,
  payload: string,
  signature: string,
  now: Date = new Date(),
): Promise<{
  agent: {
    id: string
    robotId: string
    organizationId: string
    tenantId: string
    agentVersion?: string | null
    heartbeatIntervalSeconds: number
    livenessGraceSeconds: number
    lostAfterSeconds: number
  }
  key: { id: string }
}> {
  const agent = (await em.findOne(Agent, { id: agentId } as never)) as unknown as
    | {
        id: string
        robotId: string
        organizationId: string
        tenantId: string
        status: string
        agentVersion?: string | null
        heartbeatIntervalSeconds: number
        livenessGraceSeconds: number
        lostAfterSeconds: number
      }
    | null
  if (!agent) throw new Error('Agent nie istnieje.')
  if (agent.status !== 'enrolled') throw new Error('Agent odwołany — tożsamość unieważniona.')

  const keys = (await em.find(AgentKey, { agentId } as never)) as unknown as Array<{
    id: string
    publicKey: string
    activeFrom: Date
    activeUntil?: Date | null
    revokedAt?: Date | null
  }>
  const usable = selectUsableKeys(keys, now)
  if (!usable.length) throw new Error('Agent nie ma ważnego klucza.')

  const match = usable.find((key) => verifyPayloadSignature(payload, signature, key.publicKey))
  if (!match) throw new Error('Podpis nie zgadza się z żadnym ważnym kluczem agenta.')

  return { agent, key: match }
}

registerCommand(issueEnrollmentCommand)
registerCommand(enrollAgentCommand)
registerCommand(connectAgentCommand)
registerCommand(heartbeatCommand)
registerCommand(rotateKeyCommand)
registerCommand(revokeAgentCommand)
registerCommand(sweepSessionsCommand)

export {
  issueEnrollmentCommand,
  enrollAgentCommand,
  connectAgentCommand,
  heartbeatCommand,
  rotateKeyCommand,
  revokeAgentCommand,
  sweepSessionsCommand,
}

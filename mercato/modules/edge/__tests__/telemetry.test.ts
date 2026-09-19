import { generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { ingestTelemetryCommand } from '../commands/telemetry'
import { payloads } from '../lib/crypto'
import { createFakeEm, type FakeEm } from './fakeEm'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ROBOT = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const SESSION = '55555555-5555-4555-8555-555555555555'

function ready() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const em = createFakeEm({
    Agent: [{
      id: AGENT,
      organizationId: ORG,
      tenantId: TENANT,
      robotId: ROBOT,
      status: 'enrolled',
      heartbeatIntervalSeconds: 30,
      livenessGraceSeconds: 30,
      lostAfterSeconds: 300,
    }],
    AgentKey: [{
      id: '66666666-6666-4666-8666-666666666666',
      agentId: AGENT,
      publicKey: publicKeyPem,
      activeFrom: new Date(Date.now() - 60_000),
      activeUntil: null,
      revokedAt: null,
    }],
    AgentSession: [{
      id: SESSION,
      agentId: AGENT,
      organizationId: ORG,
      tenantId: TENANT,
      lastSequence: 0,
      endedAt: null,
    }],
  })
  const execute = jest.fn(async (commandId: string, options: { input: Record<string, unknown> }) => ({
    result: { commandId, received: options.input },
  }))
  const ctx = {
    container: {
      resolve: (key: string) => key === 'commandBus' ? { execute } : em,
    },
    auth: null,
    organizationScope: { selectedId: ORG, filterIds: [ORG] },
  } as never
  const sign = (value: string) => signPayload(null, Buffer.from(value, 'utf8'), privateKey).toString('base64')
  return { em, execute, ctx, sign }
}

function envelope(
  sign: (value: string) => string,
  kind: 'episode' | 'intervention' | 'detection_window' | 'clip' | 'clip_deletion_confirmation',
  payload: Record<string, unknown>,
  sequence = 1,
) {
  const timestamp = new Date().toISOString()
  return {
    sessionId: SESSION,
    sequence,
    timestamp,
    kind,
    payload,
    signature: sign(payloads.telemetry(SESSION, sequence, timestamp, kind, payload)),
  }
}

const episode = {
  externalRef: 'edge-run-2026-09-19-0001',
  taskKey: 'sort-plastic',
  startedAt: '2026-09-19T10:00:00.000Z',
  endedAt: '2026-09-19T10:00:03.000Z',
  outcome: 'success',
  metrics: { pieces: 1 },
}

describe('edge.telemetry.ingest', () => {
  it('wyprowadza organizację, tenanta i robota z podpisanej sesji', async () => {
    const { em, execute, ctx, sign } = ready()
    const result = await ingestTelemetryCommand.execute(envelope(sign, 'episode', episode), ctx)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('episodes.episodes.record')
    expect(execute.mock.calls[0][1].input).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      robotId: ROBOT,
      externalRef: episode.externalRef,
    })
    expect(result.sequence).toBe(1)
    expect(em.rows('AgentSession')[0].lastSequence).toBe(1)
  })

  it('okno detekcji trafia do vision bez możliwości podsunięcia zakresu', async () => {
    const { execute, ctx, sign } = ready()
    const payload = {
      cameraId: '77777777-7777-4777-8777-777777777777',
      detectorVersionId: '88888888-8888-4888-8888-888888888888',
      startedAt: '2026-09-19T10:00:00.000Z',
      endedAt: '2026-09-19T10:00:05.000Z',
      framesAnalyzed: 125,
      countingMode: 'tracks',
      counts: { person: 2 },
    }
    await ingestTelemetryCommand.execute(envelope(sign, 'detection_window', payload), ctx)
    expect(execute.mock.calls[0][0]).toBe('vision.windows.record')
    expect(execute.mock.calls[0][1].input).toMatchObject({ organizationId: ORG, tenantId: TENANT })
    expect(execute.mock.calls[0][1].input).not.toHaveProperty('robotId')
  })

  it('rejestruje wyłącznie metadane klipu, a termin retencji wylicza vision', async () => {
    const { execute, ctx, sign } = ready()
    const payload = {
      cameraId: '77777777-7777-4777-8777-777777777777',
      subjectType: 'safety-event',
      subjectId: '99999999-9999-4999-8999-999999999999',
      uri: 's3://physical-evidence/cell-a/clip-42.mp4',
      recordedAt: '2026-09-19T10:00:00.000Z',
      durationSeconds: 12,
    }
    await ingestTelemetryCommand.execute(envelope(sign, 'clip', payload), ctx)
    expect(execute.mock.calls[0][0]).toBe('vision.clips.attach')
    expect(execute.mock.calls[0][1].input).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      uri: payload.uri,
    })
    expect(execute.mock.calls[0][1].input).not.toHaveProperty('deleteAfter')
  })

  it('potwierdzenie usunięcia przypisuje sprawcę z klucza agenta', async () => {
    const { execute, ctx, sign } = ready()
    const payload = { clipIds: ['99999999-9999-4999-8999-999999999999'] }
    await ingestTelemetryCommand.execute(envelope(sign, 'clip_deletion_confirmation', payload), ctx)
    expect(execute.mock.calls[0][0]).toBe('vision.clips.confirm_deletion')
    expect(execute.mock.calls[0][1].input).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      confirmedBy: `edge-agent:${AGENT}`,
      clipIds: payload.clipIds,
    })
  })

  it('agent nie może podszyć się pod inny proces potwierdzający usunięcie', async () => {
    const { ctx, sign } = ready()
    const injected = {
      clipIds: ['99999999-9999-4999-8999-999999999999'],
      confirmedBy: 'administrator',
    }
    await expect(
      ingestTelemetryCommand.execute(envelope(sign, 'clip_deletion_confirmation', injected), ctx),
    ).rejects.toThrow()
  })

  it('odrzuca zmianę treści po złożeniu podpisu', async () => {
    const { execute, ctx, sign } = ready()
    const signed = envelope(sign, 'episode', episode)
    const tampered = { ...signed, payload: { ...episode, outcome: 'failure' } }
    await expect(ingestTelemetryCommand.execute(tampered as never, ctx)).rejects.toThrow(/Podpis nie zgadza/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('odrzuca powtórzony numer kolejny i nie zapisuje drugi raz', async () => {
    const { execute, ctx, sign } = ready()
    await ingestTelemetryCommand.execute(envelope(sign, 'episode', episode, 4), ctx)
    await expect(ingestTelemetryCommand.execute(envelope(sign, 'episode', episode, 4), ctx)).rejects.toThrow(
      /powtórka lub klon/,
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('nie przesuwa licznika, gdy księga domenowa odrzuci rekord', async () => {
    const { em, execute, ctx, sign } = ready()
    execute.mockRejectedValueOnce(new Error('kamera nie istnieje'))
    await expect(ingestTelemetryCommand.execute(envelope(sign, 'episode', episode), ctx)).rejects.toThrow(
      /kamera nie istnieje/,
    )
    expect(em.rows('AgentSession')[0].lastSequence).toBe(0)
  })

  it('nie przyjmuje zakresu organizacji ani identyfikatora robota w payloadzie', async () => {
    const { ctx, sign } = ready()
    const injected = { ...episode, organizationId: ORG, robotId: ROBOT }
    await expect(ingestTelemetryCommand.execute(envelope(sign, 'episode', injected), ctx)).rejects.toThrow()
  })
})

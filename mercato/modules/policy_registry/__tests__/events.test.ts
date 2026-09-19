import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { registerVersionCommand, transitionVersionCommand } from '../commands/policies'

/**
 * Testy emisji zdarzeń rejestru polityk.
 *
 * Kluczowa reguła: ponowne wgranie tej samej treści z potoku CI **nie**
 * emituje. Odcisk treści rozstrzyga o tożsamości wersji, więc drugie wgranie
 * nie jest drugą wersją — a zdarzenie nadane przy każdym przebiegu potoku
 * uruchamiałoby automatyzacje kolejny raz na tym samym artefakcie.
 *
 * Druga: zwolnienie i wycofanie dostają własne zdarzenia obok ogólnego
 * przejścia statusu, bo reagują na nie inni odbiorcy.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const POLICY_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '55555555-5555-4555-8555-555555555555'
const REVISION_ID = '66666666-6666-4666-8666-666666666666'
const WEIGHTS = 'a'.repeat(64)
const CONFIG = 'b'.repeat(64)

function captureEvents() {
  const seen: Array<{ id: string; payload: Record<string, unknown> }> = []
  setGlobalEventBus({
    emit: async (id: string, payload: unknown) => {
      seen.push({ id, payload: payload as Record<string, unknown> })
    },
  })
  return seen
}

afterEach(() => {
  setGlobalEventBus({ emit: async () => {} })
})

function makeCtx(options: { duplicate?: Row | null; version?: Row | null } = {}) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('PolicyVersion') && !name.includes('Event')) {
        if (options.version !== undefined) return options.version
        return options.duplicate ?? null
      }
      if (name.includes('Policy')) return { id: POLICY_ID, embodimentKey: 'ur10e-pick' }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        if (query.includes('max(version)')) return [{ max: 2 }]
        if (query.includes('fleet_embodiment_revisions')) {
          return [{ id: REVISION_ID, embodiment_key: 'ur10e-pick', spec_digest: 'demo:ur10e-pick:r1' }]
        }
        return []
      }),
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = `id-${persisted.indexOf(row) + 1}`
    }),
  }
  return { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never
}

const rejestracja = {
  ...scope,
  policyId: POLICY_ID,
  embodimentRevisionId: REVISION_ID,
  declaredSpecDigest: 'demo:ur10e-pick:r1',
  artifacts: [
    { role: 'weights' as const, digest: WEIGHTS, uri: 's3://p/w.safetensors' },
    { role: 'config' as const, digest: CONFIG, uri: 's3://p/c.json' },
  ],
}

describe('emisja zdarzeń rejestru polityk', () => {
  it('nowa wersja ogłasza odcisk treści', async () => {
    const seen = captureEvents()
    await registerVersionCommand.execute(rejestracja, makeCtx())
    expect(seen.map((e) => e.id)).toEqual(['policy_registry.version.registered'])
    expect(seen[0].payload.contentDigest).toBeTruthy()
  })

  it('ponowne wgranie tej samej treści milczy', async () => {
    const seen = captureEvents()
    const result = (await registerVersionCommand.execute(
      rejestracja,
      makeCtx({ duplicate: { id: VERSION_ID, version: 2 } }),
    )) as { deduplicated: boolean }
    expect(result.deduplicated).toBe(true)
    expect(seen).toEqual([])
  })

  it('zwolnienie ogłasza przejście i zdarzenie wyróżnione', async () => {
    const seen = captureEvents()
    await transitionVersionCommand.execute(
      { ...scope, policyVersionId: VERSION_ID, toStatus: 'released', reason: 'ewaluacja zdana' },
      makeCtx({ version: { id: VERSION_ID, status: 'registered' } }),
    )
    expect(seen.map((e) => e.id)).toEqual([
      'policy_registry.version.transitioned',
      'policy_registry.version.released',
    ])
  })

  it('wycofanie ogłasza własne zdarzenie, bo ma innego odbiorcę', async () => {
    const seen = captureEvents()
    await transitionVersionCommand.execute(
      { ...scope, policyVersionId: VERSION_ID, toStatus: 'deprecated', reason: 'zastąpiona' },
      makeCtx({ version: { id: VERSION_ID, status: 'released' } }),
    )
    expect(seen.map((e) => e.id)).toEqual([
      'policy_registry.version.transitioned',
      'policy_registry.version.deprecated',
    ])
  })
})

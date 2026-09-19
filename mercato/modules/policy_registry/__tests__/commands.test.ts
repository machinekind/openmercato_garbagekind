import { registerVersionCommand, transitionVersionCommand } from '../commands/policies'
import { computeContentDigest } from '../lib/digest'
import { demoJointContract } from '../lib/vectorContract'

/**
 * Testy wiązania komend.
 *
 * Reguły mają własne testy jako czyste funkcje. Tutaj sprawdzamy rzecz osobną
 * i równie ważną: czy komenda naprawdę ich **używa** i czy zapisuje to, co
 * twierdzi. Reguła, której nikt nie woła, nie chroni niczego.
 */

type Row = Record<string, unknown>

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const POLICY_ID = '33333333-3333-4333-8333-333333333333'
const REVISION_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '55555555-5555-4555-8555-555555555555'

const WEIGHTS = 'a'.repeat(64)
const CONFIG = 'b'.repeat(64)

const ARTIFACTS = [
  { role: 'weights' as const, digest: WEIGHTS, uri: 's3://p/w.safetensors' },
  { role: 'config' as const, digest: CONFIG, uri: 's3://p/c.json' },
]

function makeCtx(options: {
  policy?: Row | null
  revisionRow?: Row | null
  duplicate?: Row | null
  maxVersion?: number | null
  version?: Row | null
} = {}) {
  const persisted: Row[] = []
  const flushes: number[] = []
  const sql: string[] = []

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown, _where: Row) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('PolicyVersion') && !name.includes('Event')) {
        // Ten sam typ obsługuje dwa pytania: „czy istnieje duplikat skrótu"
        // (rejestracja) i „czy istnieje wersja o tym id" (przejście statusu).
        if (options.version !== undefined) return options.version
        return options.duplicate ?? null
      }
      if (name.includes('Policy')) {
        return options.policy === undefined
          ? { id: POLICY_ID, embodimentKey: 'ur10e-pick' }
          : options.policy
      }
      return null
    }),
    getConnection: () => ({
      execute: jest.fn(async (query: string) => {
        sql.push(query)
        if (query.includes('fleet_embodiment_revisions')) {
          return options.revisionRow === undefined
            ? [
                {
                  id: REVISION_ID,
                  embodiment_key: 'ur10e-pick',
                  revision: 1,
                  spec_digest: 'demo:ur10e-pick:r1',
                  dof_count: 6,
                },
              ]
            : options.revisionRow
              ? [options.revisionRow]
              : []
        }
        if (query.includes('max(version)')) {
          return [{ max: options.maxVersion === undefined ? 4 : options.maxVersion }]
        }
        return []
      }),
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      __table: (entity as { name?: string })?.name,
      ...data,
    })),
    persist: jest.fn((row: Row) => {
      persisted.push(row)
    }),
    flush: jest.fn(async () => {
      // Odwzorowuje Postgresa: identyfikator pojawia się dopiero przy zrzucie.
      for (const row of persisted) if (!row.id) row.id = `id-${persisted.indexOf(row) + 1}`
      flushes.push(persisted.length)
    }),
  }

  return {
    persisted,
    flushes,
    sql,
    ctx: { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never,
  }
}

const baseInput = {
  ...scope,
  policyId: POLICY_ID,
  embodimentRevisionId: REVISION_ID,
  declaredSpecDigest: 'demo:ur10e-pick:r1',
  artifacts: ARTIFACTS,
  ...demoJointContract(6),
}

describe('policy_registry.versions.register — zgodność z embodimentem', () => {
  it('odrzuca rozjazd między deklarowanym wymiarem a uporządkowanymi polami', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerVersionCommand.execute({ ...baseInput, actionDim: 7 }, ctx),
    ).rejects.toThrow(/Suma rozmiarów pól akcji/)
  })

  it('odrzuca powtórzony klucz pola wektora', async () => {
    const { ctx } = makeCtx()
    const field = baseInput.observationSpec.fields[0]
    await expect(
      registerVersionCommand.execute({
        ...baseInput,
        observationDim: 12,
        observationSpec: { fields: [field, field] },
      }, ctx),
    ).rejects.toThrow(/Powtórzony klucz pola/)
  })

  it('odmawia rejestracji dla rewizji o innym spec_digest i podaje obie wartości', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerVersionCommand.execute(
        { ...baseInput, declaredSpecDigest: 'demo:ur10e-pick:r7' },
        ctx,
      ),
    ).rejects.toThrow(/spec_digest_mismatch/)
  })

  it('komunikat odmowy niesie oba odciski, nie tylko kod', async () => {
    const { ctx } = makeCtx()
    const error = await registerVersionCommand
      .execute({ ...baseInput, declaredSpecDigest: 'demo:ur10e-pick:r7' }, ctx)
      .catch((e: Error) => e)
    expect((error as Error).message).toContain('demo:ur10e-pick:r1')
    expect((error as Error).message).toContain('demo:ur10e-pick:r7')
  })

  it('odmawia dla rewizji z innej rodziny sprzętu', async () => {
    const { ctx } = makeCtx({
      revisionRow: {
        id: REVISION_ID,
        embodiment_key: 'fr3-assembly',
        revision: 1,
        spec_digest: 'demo:fr3-assembly:r1',
        dof_count: 7,
      },
    })
    await expect(
      registerVersionCommand.execute(
        { ...baseInput, declaredSpecDigest: 'demo:fr3-assembly:r1' },
        ctx,
      ),
    ).rejects.toThrow(/embodiment_key_mismatch/)
  })

  it('odmawia, gdy wskazana rewizja nie istnieje', async () => {
    const { ctx } = makeCtx({ revisionRow: null })
    await expect(registerVersionCommand.execute(baseInput, ctx)).rejects.toThrow(/no_embodiment/)
  })

  it('nie zapisuje niczego, gdy embodiment się nie zgadza', async () => {
    const { ctx, persisted } = makeCtx({ revisionRow: null })
    await registerVersionCommand.execute(baseInput, ctx).catch(() => undefined)
    expect(persisted).toHaveLength(0)
  })

  it('komplet artefaktów jest sprawdzany przed embodimentem', async () => {
    // Kolejność komunikatów: błąd wgrywającego ma wyjść przed błędem wdrożeniowym.
    const { ctx } = makeCtx({ revisionRow: null })
    await expect(
      registerVersionCommand.execute(
        { ...baseInput, artifacts: [{ role: 'config' as const, digest: CONFIG, uri: 's3://p/c.json' }] },
        ctx,
      ),
    ).rejects.toThrow(/Komplet artefaktów odrzucony/)
  })
})

describe('policy_registry.versions.register — tożsamość przez skrót', () => {
  it('zwraca istniejącą wersję zamiast tworzyć drugą, gdy wagi te same', async () => {
    const { ctx, persisted } = makeCtx({ duplicate: { id: VERSION_ID, version: 2, ...demoJointContract(6) } })
    const result = await registerVersionCommand.execute(baseInput, ctx)
    expect(result).toMatchObject({ policyVersionId: VERSION_ID, version: 2, deduplicated: true })
    // Nic nie zostało zapisane — to jest cała treść „dwa wgrania to jedna wersja".
    expect(persisted).toHaveLength(0)
  })

  it('nie pozwala opisać tych samych wag innymi jednostkami lub semantyką', async () => {
    const { ctx } = makeCtx({ duplicate: { id: VERSION_ID, version: 2, ...demoJointContract(6) } })
    await expect(registerVersionCommand.execute({
      ...baseInput,
      actionSpec: {
        fields: [{ ...baseInput.actionSpec.fields[0], unit: 'deg' as const }],
      },
    }, ctx)).rejects.toThrow(/tym samym wagom nowych jednostek/)
  })

  it('liczy skrót treści tak samo jak czysta funkcja', async () => {
    const { ctx } = makeCtx()
    const result = await registerVersionCommand.execute(baseInput, ctx)
    expect(result.contentDigest).toBe(computeContentDigest(ARTIFACTS))
    expect(result.deduplicated).toBe(false)
  })

  it('kolejność podania artefaktów nie zmienia skrótu wersji', async () => {
    const first = await registerVersionCommand.execute(baseInput, makeCtx().ctx)
    const second = await registerVersionCommand.execute(
      { ...baseInput, artifacts: [...ARTIFACTS].reverse() },
      makeCtx().ctx,
    )
    expect(first.contentDigest).toBe(second.contentDigest)
  })

  it('nadaje numer kolejny jako max+1, bo numer jest tylko etykietą', async () => {
    const { ctx } = makeCtx({ maxVersion: 4 })
    const result = await registerVersionCommand.execute(baseInput, ctx)
    expect(result.version).toBe(5)
  })

  it('pierwsza wersja polityki dostaje numer 1', async () => {
    const { ctx } = makeCtx({ maxVersion: null })
    const result = await registerVersionCommand.execute(baseInput, ctx)
    expect(result.version).toBe(1)
  })
})

describe('policy_registry.versions.register — zapis', () => {
  it('zapisuje wersję, komplet artefaktów i wpis do dziennika', async () => {
    const { ctx, persisted } = makeCtx()
    await registerVersionCommand.execute(baseInput, ctx)
    const tables = persisted.map((row) => row.__table)
    expect(tables).toContain('PolicyVersion')
    expect(tables.filter((t) => t === 'PolicyArtifact')).toHaveLength(2)
    expect(tables).toContain('PolicyVersionEvent')
  })

  it('robi dwa zrzuty, bo identyfikator wersji nadaje baza', async () => {
    // Gdyby artefakty szły w tym samym zrzucie co wersja, wskazywałyby na puste
    // `policy_version_id` — to jest ten sam błąd, który wywrócił rejestrację robota.
    const { ctx, flushes } = makeCtx()
    await registerVersionCommand.execute(baseInput, ctx)
    expect(flushes.length).toBeGreaterThanOrEqual(2)
    expect(flushes[0]).toBe(1)
  })

  it('kopiuje odcisk kontraktu z rewizji, a nie z deklaracji wgrywającego', async () => {
    // Denormalizacja ma być kopią prawdy z rejestru floty; kopiowanie deklaracji
    // uczyniłoby z niej powtórzenie tego, co właśnie sprawdziliśmy.
    const { ctx, persisted } = makeCtx()
    await registerVersionCommand.execute(baseInput, ctx)
    const version = persisted.find((row) => row.__table === 'PolicyVersion')!
    expect(version.embodimentSpecDigest).toBe('demo:ur10e-pick:r1')
    expect(version.status).toBe('registered')
    expect(version.observationSpec).toEqual(baseInput.observationSpec)
    expect(version.actionSpec).toEqual(baseInput.actionSpec)
    expect(version.controlFrequencyHz).toBe(20)
    expect(version.leaseExpiryBehavior).toBe('hold_position')
  })

  it('odmawia, gdy polityka nie istnieje', async () => {
    const { ctx } = makeCtx({ policy: null })
    await expect(registerVersionCommand.execute(baseInput, ctx)).rejects.toThrow(/nie istnieje/)
  })
})

describe('policy_registry.versions.transition', () => {
  it('wypuszcza zarejestrowaną wersję i dopisuje wpis do dziennika', async () => {
    const { ctx, persisted } = makeCtx({ version: { id: VERSION_ID, status: 'registered' } })
    const result = await transitionVersionCommand.execute(
      { ...scope, policyVersionId: VERSION_ID, toStatus: 'released', reason: 'Testy odbiorcze' },
      ctx,
    )
    expect(result).toMatchObject({ fromStatus: 'registered', toStatus: 'released' })
    expect(persisted.map((r) => r.__table)).toContain('PolicyVersionEvent')
  })

  it('nie pozwala cofnąć wypuszczonej wersji do zarejestrowanej', async () => {
    // Cofnięcie skasowałoby ślad, że coś tam działało. Droga wyjścia to `deprecated`.
    const { ctx } = makeCtx({ version: { id: VERSION_ID, status: 'released' } })
    await expect(
      transitionVersionCommand.execute(
        { ...scope, policyVersionId: VERSION_ID, toStatus: 'registered', reason: 'pomyłka' },
        ctx,
      ),
    ).rejects.toThrow(/nie da się przejść/)
  })

  it('wycofana wersja jest stanem końcowym', async () => {
    const { ctx } = makeCtx({ version: { id: VERSION_ID, status: 'deprecated' } })
    await expect(
      transitionVersionCommand.execute(
        { ...scope, policyVersionId: VERSION_ID, toStatus: 'released', reason: 'powrót' },
        ctx,
      ),
    ).rejects.toThrow(/status końcowy/)
  })

  it('odmawia przejścia do tego samego statusu', async () => {
    const { ctx } = makeCtx({ version: { id: VERSION_ID, status: 'released' } })
    await expect(
      transitionVersionCommand.execute(
        { ...scope, policyVersionId: VERSION_ID, toStatus: 'released', reason: 'ponownie' },
        ctx,
      ),
    ).rejects.toThrow(/już w statusie/)
  })
})

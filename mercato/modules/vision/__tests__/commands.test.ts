import { createHash } from 'node:crypto'
import {
  attachClipCommand,
  confirmDeletionCommand,
  purgeClipsCommand,
  recordWindowCommand,
  registerCameraCommand,
  registerDetectorCommand,
} from '../commands/vision'

/**
 * Testy wiązania komend wzroku.
 *
 * Sprawdzamy to, czego czyste funkcje nie obejmują: czy komendy naprawdę
 * **odmawiają**. Moduł ostrzegający i moduł odmawiający wyglądają w dokumentacji
 * tak samo — różnią się dopiero w dniu kontroli.
 */

type Row = Record<string, unknown>

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const CELL = '33333333-3333-4333-8333-333333333333'
const scope = { organizationId: ORG, tenantId: TENANT }
const digest = createHash('sha256').update('wagi').digest('hex')

function makeCtx(options: { camera?: Row | null; detector?: Row | null; window?: Row | null; clips?: Row[] } = {}) {
  const persisted: Row[] = []
  const em = {
    fork: () => em,
    findOne: jest.fn(async (entity: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('DetectorVersion')) return options.detector ?? null
      if (name.includes('DetectionWindow')) return options.window ?? null
      if (name.includes('Camera')) return options.camera ?? null
      return null
    }),
    // `$in` obsłużone wprost: komenda potwierdzenia filtruje po liście identyfikatorów.
    find: jest.fn(async () => options.clips ?? []),
    create: jest.fn((entity: unknown, data: Row) => ({ __table: (entity as { name?: string })?.name, ...data })),
    persist: jest.fn((row: Row) => persisted.push(row)),
    flush: jest.fn(async () => {
      for (const row of persisted) if (!row.id) row.id = 'nowy-1'
    }),
  }
  return {
    persisted,
    ctx: { container: { resolve: () => em }, auth: { sub: 'user-1' } } as never,
  }
}

const KAMERA = {
  id: '44444444-4444-4444-8444-444444444444',
  organizationId: ORG,
  cellId: CELL,
  retentionDays: 14,
  classVocabulary: undefined,
}

describe('vision.cameras.register', () => {
  const poprawna = {
    ...scope,
    cellId: CELL,
    code: 'BIN-CAM-1',
    name: 'Kamera nad pojemnikiem',
    viewRole: 'bin_outfeed',
    purpose: 'production_control' as const,
    retentionDays: 14,
    peopleInView: true,
  }

  it('ODMAWIA przechowywania dłuższego niż ustawowe trzy miesiące, z powodem prawnym', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerCameraCommand.execute({ ...poprawna, retentionDays: 365 }, ctx),
    ).rejects.toThrow(/22² § 3/)
  })

  it('ODMAWIA celu spoza zamkniętego katalogu ustawowego', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerCameraCommand.execute({ ...poprawna, purpose: 'ocena_pracownikow' as never }, ctx),
    ).rejects.toThrow()
  })

  it('zwraca braki formalne wołającemu, zamiast chować je w logu', async () => {
    // Brak poinformowania załogi nie unieważnia rejestracji, ale musi
    // dotrzeć do człowieka PRZED uruchomieniem kamery.
    const { ctx } = makeCtx()
    const wynik = await registerCameraCommand.execute(poprawna, ctx)
    expect(wynik.warnings.join(' ')).toMatch(/§ 7|§ 9/)
  })

  it('kamera bez ludzi w kadrze nie generuje braków formalnych', async () => {
    const { ctx } = makeCtx()
    const wynik = await registerCameraCommand.execute({ ...poprawna, peopleInView: false }, ctx)
    expect(wynik.warnings).toHaveLength(0)
  })
})

describe('vision.detectors.register', () => {
  const poprawny = {
    ...scope,
    detectorKey: 'bin-material',
    revision: 1,
    name: 'Klasyfikacja frakcji',
    weightsDigest: digest,
    classVocabulary: ['pet', 'pvc'],
    confidenceThreshold: 0.55,
  }

  it('ODMAWIA detektora wnioskującego emocje w miejscu pracy', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerDetectorCommand.execute({ ...poprawny, classVocabulary: ['pet', 'operator_emotion'] }, ctx),
    ).rejects.toThrow(/2024\/1689/)
  })

  it('odmawia progu ufności równego zeru', async () => {
    // Próg zero daje zliczenia hipotez modelu, nie obiektów — a taka liczba
    // wchodzi potem do triangulacji jako pełnoprawny świadek.
    const { ctx } = makeCtx()
    await expect(
      registerDetectorCommand.execute({ ...poprawny, confidenceThreshold: 0 }, ctx),
    ).rejects.toThrow(/hipotez/)
  })

  it('odmawia skrótu wag, który nie jest sha256', async () => {
    const { ctx } = makeCtx()
    await expect(
      registerDetectorCommand.execute({ ...poprawny, weightsDigest: 'abc' }, ctx),
    ).rejects.toThrow()
  })

  it('powtórna rejestracja tych samych wag nie tworzy drugiej rewizji', async () => {
    const { ctx, persisted } = makeCtx({ detector: { id: 'istnieje', weightsDigest: digest } })
    const wynik = await registerDetectorCommand.execute(poprawny, ctx)
    expect(wynik.detectorVersionId).toBe('istnieje')
    expect(persisted).toHaveLength(0)
  })

  it('odmawia podmiany wag pod tym samym numerem rewizji', async () => {
    const { ctx } = makeCtx({ detector: { id: 'istnieje', weightsDigest: 'inny'.padEnd(64, '0') } })
    await expect(registerDetectorCommand.execute(poprawny, ctx)).rejects.toThrow(/Podnieś numer rewizji/)
  })
})

describe('vision.windows.record', () => {
  const okno = {
    ...scope,
    cameraId: KAMERA.id,
    detectorVersionId: '55555555-5555-4555-8555-555555555555',
    startedAt: new Date('2026-09-18T06:00:00Z'),
    endedAt: new Date('2026-09-18T06:30:00Z'),
    framesAnalyzed: 54_000,
    countingMode: 'tracks' as const,
    counts: { pet: 1000 },
  }

  it('ODMAWIA klas spoza słownika detektora', async () => {
    // Zliczenie klasy, której detektor według rejestru nie potrafi zwrócić,
    // znaczy, że na brzegu działa inny model niż zapisany.
    const { ctx } = makeCtx({
      camera: KAMERA,
      detector: { id: okno.detectorVersionId, classVocabulary: ['pet'] },
    })
    await expect(
      recordWindowCommand.execute({ ...okno, counts: { pet: 1000, hdpe: 5 } }, ctx),
    ).rejects.toThrow(/inny model/)
  })

  it('jest idempotentne po kamerze, początku okna i detektorze', async () => {
    const { ctx, persisted } = makeCtx({
      camera: KAMERA,
      detector: { id: okno.detectorVersionId, classVocabulary: ['pet'] },
      window: { id: 'juz-jest' },
    })
    const wynik = await recordWindowCommand.execute(okno, ctx)
    expect(wynik.action).toBe('skipped')
    expect(persisted).toHaveLength(0)
  })

  it('odmawia okna kończącego się przed rozpoczęciem', async () => {
    const { ctx } = makeCtx({
      camera: KAMERA,
      detector: { id: okno.detectorVersionId, classVocabulary: ['pet'] },
    })
    await expect(
      recordWindowCommand.execute({ ...okno, endedAt: new Date('2026-09-18T05:00:00Z') }, ctx),
    ).rejects.toThrow(/późniejszy niż jego początek/)
  })
})

describe('vision.clips.attach', () => {
  it('TERMIN USUNIĘCIA LICZY SIĘ Z KAMERY, nie przychodzi z wejścia', async () => {
    const { ctx } = makeCtx({ camera: KAMERA })
    const nagranie = new Date('2026-09-18T06:00:00Z')
    const wynik = await attachClipCommand.execute(
      {
        ...scope,
        cameraId: KAMERA.id,
        subjectType: 'episode',
        uri: 's3://klipy/a.mp4',
        recordedAt: nagranie,
        durationSeconds: 30,
      },
      ctx,
    )
    // 14 dni z ustawienia kamery — wołający nie ma jak tego wydłużyć.
    expect(Math.round((wynik.deleteAfter.getTime() - nagranie.getTime()) / 86_400_000)).toBe(14)
  })

  it('w bazie ląduje adres, nigdy bajty', async () => {
    const { ctx, persisted } = makeCtx({ camera: KAMERA })
    await attachClipCommand.execute(
      {
        ...scope,
        cameraId: KAMERA.id,
        subjectType: 'episode',
        uri: 's3://klipy/a.mp4',
        recordedAt: new Date(),
        durationSeconds: 30,
      },
      ctx,
    )
    expect(persisted[0]).toMatchObject({ uri: 's3://klipy/a.mp4' })
    expect(JSON.stringify(persisted[0])).not.toMatch(/base64|blob|bytes/i)
  })
})

describe('vision.clips.purge', () => {
  const wczoraj = new Date(Date.now() - 86_400_000)
  const jutro = new Date(Date.now() + 86_400_000)

  it('oznacza do usunięcia wyłącznie materiał po terminie', async () => {
    const { ctx } = makeCtx({
      clips: [
        { id: 'a', uri: 's3://a', deleteAfter: wczoraj, markedForDeletionAt: null },
        { id: 'b', uri: 's3://b', deleteAfter: jutro, markedForDeletionAt: null },
      ],
    })
    const wynik = await purgeClipsCommand.execute({ tenantId: TENANT }, ctx)
    expect(wynik.purged).toEqual([{ clipId: 'a', uri: 's3://a' }])
  })

  it('wstrzymanie dowodowe zatrzymuje usunięcie', async () => {
    const { ctx } = makeCtx({
      clips: [{ id: 'a', uri: 's3://a', deleteAfter: wczoraj, markedForDeletionAt: null, legalHoldReference: 'II K 123/26' }],
    })
    const wynik = await purgeClipsCommand.execute({ tenantId: TENANT }, ctx)
    expect(wynik.purged).toHaveLength(0)
    expect(wynik.heldBack).toBe(1)
  })

  it('zwraca adresy do skasowania, ale plików nie kasuje', async () => {
    // ERP nie ma dostępu do magazynu obiektów i nie powinien mieć — inaczej
    // stałby się systemem zdolnym nieodwracalnie usunąć materiał dowodowy.
    const { ctx } = makeCtx({ clips: [{ id: 'a', uri: 's3://a', deleteAfter: wczoraj, markedForDeletionAt: null }] })
    const wynik = await purgeClipsCommand.execute({ tenantId: TENANT }, ctx)
    expect(wynik.purged[0].uri).toBe('s3://a')
  })
})

describe('vision.clips.confirm_deletion', () => {
  /**
   * Rozdział „oznaczone" od „usunięte" to jedyna rzecz, która odróżnia
   * zgodność od zautomatyzowanej księgowości. Zadanie cykliczne oznacza
   * materiał co dobę; gdyby na tym poprzestać, ekran pokazywałby zero
   * zaległości przy nagraniach, które wciąż leżą na dysku.
   */
  it('potwierdza usunięcie oznaczonego materiału', async () => {
    const { ctx } = makeCtx({
      clips: [{ id: 'a', markedForDeletionAt: new Date(), deletionConfirmedAt: null }],
    })
    const wynik = await confirmDeletionCommand.execute(
      { tenantId: TENANT, clipIds: ['44444444-4444-4444-8444-444444444444'], confirmedBy: 's3-lifecycle' },
      ctx,
    )
    expect(wynik.confirmed).toBe(1)
  })

  it('ODMAWIA potwierdzenia materiału, którego nikt nie oznaczył', async () => {
    // Znaczy to, że skasowano go poza procesem — może przed terminem,
    // może mimo wstrzymania dowodowego. Zapis zamykałby sprawę, która
    // tylko wygląda na zamkniętą.
    const { ctx } = makeCtx({
      clips: [{ id: 'a', markedForDeletionAt: null, deletionConfirmedAt: null }],
    })
    const wynik = await confirmDeletionCommand.execute(
      { tenantId: TENANT, clipIds: ['44444444-4444-4444-8444-444444444444'], confirmedBy: 'ktos' },
      ctx,
    )
    expect(wynik.confirmed).toBe(0)
    expect(wynik.rejected).toHaveLength(1)
  })

  it('powtórne potwierdzenie nie zmienia zapisu', async () => {
    const wczesniej = new Date(Date.now() - 3600_000)
    const clip = { id: 'a', markedForDeletionAt: wczesniej, deletionConfirmedAt: wczesniej, deletionConfirmedBy: 'pierwszy' }
    const { ctx } = makeCtx({ clips: [clip] })
    const wynik = await confirmDeletionCommand.execute(
      { tenantId: TENANT, clipIds: ['44444444-4444-4444-8444-444444444444'], confirmedBy: 'drugi' },
      ctx,
    )
    expect(wynik.confirmed).toBe(0)
    expect(clip.deletionConfirmedBy).toBe('pierwszy')
  })
})

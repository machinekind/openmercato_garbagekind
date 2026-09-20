import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Camera, Clip, DetectionWindow, DetectorVersion } from '../data/entities'
import { checkCamera, checkClassVocabulary, deleteAfterFor, LAWFUL_PURPOSES, MAX_RETENTION_DAYS } from '../lib/lawful'
import { emitVisionEvent } from '../events'

/**
 * Komendy wzroku maszynowego.
 *
 * Dwie z nich (`cameras.register`, `detectors.register`) są w istocie bramkami
 * prawnymi: sprawdzają to, czego żaden przegląd kodu po fakcie nie wyłapie,
 * i **odmawiają zapisu**, zamiast ostrzegać. Ostrzeżenie, które da się kliknąć,
 * jest ostrzeżeniem, które zostanie kliknięte.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

/* ------------------------------------------------------------------ */

export const registerCameraSchema = scoped.extend({
  cellId: z.string().uuid(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(191),
  viewRole: z.string().trim().min(1).max(64),
  purpose: z.enum(LAWFUL_PURPOSES),
  /*
   * Górna granica egzekwowana już w schemacie, z powodem prawnym w komunikacie.
   * Surowy zrzut walidatora („Too big: expected number to be <=90") mówi
   * operatorowi, że coś odpadło, i nie mówi, dlaczego ani czego się trzymać.
   */
  retentionDays: z
    .number()
    .int()
    .min(1, 'Okres przechowywania musi być dodatni.')
    .max(
      MAX_RETENTION_DAYS,
      `Okres przechowywania nie może przekroczyć ${MAX_RETENTION_DAYS} dni - art. 22² § 3 Kodeksu pracy nakazuje ` +
        'zniszczenie nagrań po trzech miesiącach. Dłużej wolno wyłącznie nagraniu stanowiącemu dowód w postępowaniu.',
    ),
  peopleInView: z.boolean().default(true),
  workforceNotifiedAt: z.coerce.date().nullable().optional(),
  areaMarkedAt: z.coerce.date().nullable().optional(),
  resolution: z.string().trim().max(32).optional(),
  framesPerSecond: z.number().int().positive().max(240).optional(),
})

export type RegisterCameraInput = z.infer<typeof registerCameraSchema>

const registerCameraCommand: CommandHandler<
  RegisterCameraInput,
  { cameraId: string; warnings: string[] }
> = {
  id: 'vision.cameras.register',
  async execute(rawInput, ctx) {
    const input = registerCameraSchema.parse(rawInput ?? {})

    const verdict = checkCamera({
      purpose: input.purpose,
      retentionDays: input.retentionDays,
      peopleInView: input.peopleInView,
      workforceNotifiedAt: input.workforceNotifiedAt ?? null,
      areaMarkedAt: input.areaMarkedAt ?? null,
    })
    if (!verdict.lawful) {
      throw new Error(`Kamery nie da się zarejestrować: ${verdict.problems.join(' ')}`)
    }

    const em = resolveEm(ctx)
    const istnieje = await em.findOne(Camera, { tenantId: input.tenantId, code: input.code } as never)
    if (istnieje) throw new Error(`Kamera o kodzie ${input.code} już istnieje.`)

    const camera = em.create(Camera, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      cellId: input.cellId,
      code: input.code,
      name: input.name,
      viewRole: input.viewRole,
      purpose: input.purpose,
      retentionDays: input.retentionDays,
      peopleInView: input.peopleInView,
      workforceNotifiedAt: input.workforceNotifiedAt ?? null,
      areaMarkedAt: input.areaMarkedAt ?? null,
      resolution: input.resolution ?? null,
      framesPerSecond: input.framesPerSecond ?? null,
    } as never)
    em.persist(camera)
    await em.flush()

    /*
     * Ostrzeżenia wracają do wołającego, a nie znikają w logu. Brak
     * poinformowania załogi jest wadą usuwalną - ale tylko wtedy, gdy ktoś
     * się o niej dowie przed uruchomieniem kamery.
     */
    const cameraId = (camera as unknown as { id: string }).id
    await emitVisionEvent('vision.camera.registered', {
      id: cameraId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      cellId: input.cellId,
      code: input.code,
      purpose: input.purpose,
      retentionDays: input.retentionDays,
      peopleInView: input.peopleInView,
    })

    if (verdict.warnings.length) {
      // Osobne zdarzenie, bo odbiorca jest inny: rejestracja kamery interesuje
      // tablicę wyposażenia, braki formalne interesują tego, kto odpowiada
      // za zgodność - i ma je usunąć, zanim kamera ruszy.
      await emitVisionEvent('vision.camera.compliance_warning', {
        id: cameraId,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        code: input.code,
        warnings: verdict.warnings,
      })
    }

    return { cameraId, warnings: verdict.warnings }
  },
}

/* ------------------------------------------------------------------ */

export const registerDetectorSchema = scoped.extend({
  detectorKey: z.string().trim().min(1).max(120),
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(191),
  weightsDigest: z.string().trim().regex(/^[0-9a-f]{64}$/, 'Skrót wag musi być sha256 w hex (64 znaki).'),
  classVocabulary: z.array(z.string().trim().min(1)).min(1),
  confidenceThreshold: z.number().min(0).max(1),
  inputResolution: z.string().trim().max(32).optional(),
})

export type RegisterDetectorInput = z.infer<typeof registerDetectorSchema>

const registerDetectorCommand: CommandHandler<
  RegisterDetectorInput,
  { detectorVersionId: string; presenceOnly: string[] }
> = {
  id: 'vision.detectors.register',
  async execute(rawInput, ctx) {
    const input = registerDetectorSchema.parse(rawInput ?? {})

    // Bramka z art. 5 rozporządzenia 2024/1689. Odmowa, nie ostrzeżenie.
    const verdict = checkClassVocabulary(input.classVocabulary)
    if (!verdict.allowed) throw new Error(verdict.reason)

    if (input.confidenceThreshold <= 0) {
      /*
       * Próg zero znaczy „licz wszystko, czego model dotknął". Taka liczba
       * nie jest pomiarem obiektów, tylko pomiarem czułości modelu - i wchodzi
       * potem do triangulacji jako pełnoprawny świadek.
       */
      throw new Error('Próg ufności równy zeru nie daje zliczeń obiektów, tylko zliczenia hipotez detektora.')
    }

    const em = resolveEm(ctx)
    const istnieje = (await em.findOne(DetectorVersion, {
      tenantId: input.tenantId,
      detectorKey: input.detectorKey,
      revision: input.revision,
    } as never)) as unknown as { id: string; weightsDigest: string } | null

    if (istnieje) {
      if (istnieje.weightsDigest === input.weightsDigest) {
        return { detectorVersionId: istnieje.id, presenceOnly: verdict.presenceOnly }
      }
      // Rewizja jest niezmienna - te same powody, co przy rewizji embodimentu:
      // zliczenia z przeszłości wiążą się z tym numerem.
      throw new Error(
        `Rewizja ${input.detectorKey} r${input.revision} istnieje z innymi wagami. Podnieś numer rewizji.`,
      )
    }

    const detector = em.create(DetectorVersion, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      detectorKey: input.detectorKey,
      revision: input.revision,
      name: input.name,
      weightsDigest: input.weightsDigest,
      classVocabulary: input.classVocabulary,
      confidenceThreshold: input.confidenceThreshold,
      inputResolution: input.inputResolution ?? null,
    } as never)
    em.persist(detector)
    await em.flush()

    // Ścieżka „ta sama rewizja, te same wagi" wyżej nie emituje: to jest
    // ponowne zgłoszenie tego samego detektora, nie nowa wersja.
    const detectorVersionId = (detector as unknown as { id: string }).id
    await emitVisionEvent('vision.detector.registered', {
      id: detectorVersionId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      detectorKey: input.detectorKey,
      revision: input.revision,
      weightsDigest: input.weightsDigest,
      presenceOnly: verdict.presenceOnly,
    })

    return { detectorVersionId, presenceOnly: verdict.presenceOnly }
  },
}

/* ------------------------------------------------------------------ */

export const recordWindowSchema = scoped.extend({
  cameraId: z.string().uuid(),
  detectorVersionId: z.string().uuid(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  framesAnalyzed: z.number().int().nonnegative(),
  countingMode: z.enum(['tracks', 'detections']),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  meanConfidence: z.record(z.string(), z.number().min(0).max(1)).optional(),
})

export type RecordWindowInput = z.infer<typeof recordWindowSchema>

const recordWindowCommand: CommandHandler<RecordWindowInput, { windowId: string; action: 'created' | 'skipped' }> = {
  id: 'vision.windows.record',
  async execute(rawInput, ctx) {
    const input = recordWindowSchema.parse(rawInput ?? {})
    if (input.endedAt.getTime() <= input.startedAt.getTime()) {
      throw new Error('Koniec okna musi być późniejszy niż jego początek.')
    }

    const em = resolveEm(ctx)
    const camera = (await em.findOne(Camera, {
      id: input.cameraId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; cellId: string; organizationId: string } | null
    if (!camera) throw new Error('Kamera nie istnieje.')

    const detector = (await em.findOne(DetectorVersion, {
      id: input.detectorVersionId,
      tenantId: input.tenantId,
    } as never)) as unknown as { id: string; classVocabulary: string[] } | null
    if (!detector) throw new Error('Wersja detektora nie istnieje.')

    /*
     * Klasy spoza zadeklarowanego słownika są odrzucane. Zliczenie klasy,
     * której detektor według rejestru nie potrafi zwrócić, znaczy, że
     * na brzegu działa co innego, niż tu zapisano - a wtedy próg ufności
     * i skrót wag w rejestrze nie opisują niczego.
     */
    const obce = Object.keys(input.counts).filter((klasa) => !detector.classVocabulary.includes(klasa))
    if (obce.length) {
      throw new Error(
        `Zliczenia zawierają klasy spoza słownika detektora: ${obce.join(', ')}. ` +
          'Na brzegu działa inny model, niż zapisano w rejestrze.',
      )
    }

    const istnieje = (await em.findOne(DetectionWindow, {
      cameraId: input.cameraId,
      startedAt: input.startedAt,
      detectorVersionId: input.detectorVersionId,
    } as never)) as unknown as { id: string } | null
    // Idempotencja po (kamera, początek okna, detektor): ponowne przysłanie
    // tego samego okna przy powtórce łącza nie ma podwajać zliczeń.
    if (istnieje) return { windowId: istnieje.id, action: 'skipped' }

    const window = em.create(DetectionWindow, {
      organizationId: camera.organizationId,
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      cellId: camera.cellId,
      detectorVersionId: input.detectorVersionId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      framesAnalyzed: input.framesAnalyzed,
      countingMode: input.countingMode,
      counts: input.counts,
      meanConfidence: input.meanConfidence ?? null,
    } as never)
    em.persist(window)
    await em.flush()

    // Wyjście idempotentne wyżej (`action: 'skipped'`) nie emituje: powtórka
    // okna po zerwaniu łącza nie jest drugim oknem.
    const windowId = (window as unknown as { id: string }).id
    await emitVisionEvent('vision.window.recorded', {
      id: windowId,
      organizationId: camera.organizationId,
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      cellId: camera.cellId,
      detectorVersionId: input.detectorVersionId,
      startedAt: input.startedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      counts: input.counts,
      countingMode: input.countingMode,
    })

    return { windowId, action: 'created' }
  },
}

/* ------------------------------------------------------------------ */

export const attachClipSchema = scoped.extend({
  cameraId: z.string().uuid(),
  subjectType: z.string().trim().min(1).max(64),
  subjectId: z.string().uuid().nullable().optional(),
  uri: z.string().trim().min(1).max(1000),
  recordedAt: z.coerce.date(),
  durationSeconds: z.number().int().positive().max(3600),
})

export type AttachClipInput = z.infer<typeof attachClipSchema>

const attachClipCommand: CommandHandler<AttachClipInput, { clipId: string; deleteAfter: Date }> = {
  id: 'vision.clips.attach',
  async execute(rawInput, ctx) {
    const input = attachClipSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const camera = (await em.findOne(Camera, {
      id: input.cameraId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; organizationId: string; retentionDays: number } | null
    if (!camera) throw new Error('Kamera nie istnieje.')

    /*
     * Termin usunięcia **liczony z kamery**, nigdy przyjmowany od wołającego.
     * Gdyby wchodził wejściem, byłby pierwszym polem, które ktoś ustawi na
     * rok - i art. 22² § 3 KP przestałby cokolwiek znaczyć.
     */
    const deleteAfter = deleteAfterFor(input.recordedAt, camera.retentionDays)

    const clip = em.create(Clip, {
      organizationId: camera.organizationId,
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      uri: input.uri,
      recordedAt: input.recordedAt,
      durationSeconds: input.durationSeconds,
      deleteAfter,
    } as never)
    em.persist(clip)
    await em.flush()

    return { clipId: (clip as unknown as { id: string }).id, deleteAfter }
  },
}

/* ------------------------------------------------------------------ */

export const purgeClipsSchema = scoped.partial().extend({ tenantId: z.string().uuid() })
export type PurgeClipsInput = z.infer<typeof purgeClipsSchema>

const purgeClipsCommand: CommandHandler<
  PurgeClipsInput,
  { purged: Array<{ clipId: string; uri: string }>; heldBack: number }
> = {
  id: 'vision.clips.purge',
  async execute(rawInput, ctx) {
    const input = purgeClipsSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const now = new Date()

    const przeterminowane = (await em.find(Clip, {
      tenantId: input.tenantId,
      markedForDeletionAt: null,
    } as never)) as unknown as Array<{
      id: string
      uri: string
      deleteAfter: Date
      markedForDeletionAt?: Date | null
      legalHoldReference?: string | null
    }>

    const purged: Array<{ clipId: string; uri: string }> = []
    let heldBack = 0

    for (const clip of przeterminowane) {
      if (clip.deleteAfter.getTime() > now.getTime()) continue
      if (clip.legalHoldReference) {
        // Jedyny wyjątek przewidziany w ustawie - i wymaga sygnatury,
        // a nie samego zaznaczenia pola.
        heldBack += 1
        continue
      }
      clip.markedForDeletionAt = now
      purged.push({ clipId: clip.id, uri: clip.uri })
    }
    await em.flush()

    /**
     * Zwracamy adresy do skasowania, **nie kasujemy plików**.
     *
     * Oznaczenie nie jest usunięciem i od tej wersji nazywa się tak, jak
     * działa. Zgodność zamyka dopiero `vision.clips.confirm_deletion`,
     * wołane przez tego, kto naprawdę skasował bajty.
     *
     * Bajty leżą w magazynie obiektów, do którego ta platforma nie ma i nie
     * powinna mieć dostępu - inaczej ERP stałby się systemem, który potrafi
     * nieodwracalnie usunąć materiał dowodowy. Wpis w bazie mówi „ten plik
     * ma zniknąć"; kasuje ten, kto go trzyma.
     */
    if (purged.length > 0) {
      await emitVisionEvent('vision.clips.marked_for_deletion', {
        organizationId: input.organizationId ?? null,
        tenantId: input.tenantId,
        markedCount: purged.length,
        heldBack,
        clipIds: purged.map((clip) => clip.clipId),
      })
    }

    /**
     * Liczba, która naprawdę mówi o zgodności: materiał oznaczony i nadal
     * istniejący, bo nikt nie potwierdził skasowania bajtów. Liczona tutaj,
     * a nie w workerze, bo w workerze była liczona globalnie i przez to
     * nie dało się jej nikomu przypisać.
     *
     * To zdarzenie **powtarza się** przy każdym przebiegu, dopóki stan trwa -
     * świadomie, wbrew zasadzie wyzwalania zboczem obowiązującej w reszcie
     * wtyczki. „Dziś nadal przechowujemy nagranie po ustawowym terminie"
     * jest prawdziwe każdego dnia z osobna i każdego dnia z osobna jest
     * naruszeniem; ogłoszenie go raz i zamilknięcie zamieniłoby trwające
     * naruszenie w jednorazową notkę.
     */
    const zaległe = await em.getConnection().execute<Array<{ count: string; oldest: string | null }>>(
      `select count(*) as count, min(marked_for_deletion_at) as oldest from vision_clips
        where tenant_id = ? and marked_for_deletion_at is not null and deletion_confirmed_at is null`,
      [input.tenantId],
    )
    const niepotwierdzone = Number(zaległe?.[0]?.count ?? 0)
    if (niepotwierdzone > 0) {
      await emitVisionEvent('vision.clips.deletion_overdue', {
        organizationId: input.organizationId ?? null,
        tenantId: input.tenantId,
        unconfirmed: niepotwierdzone,
        oldestMarkedAt: zaległe?.[0]?.oldest ?? null,
      })
    }

    return { purged, heldBack }
  },
}

/* ------------------------------------------------------------------ */

export const confirmDeletionSchema = scoped.partial().extend({
  tenantId: z.string().uuid(),
  clipIds: z.array(z.string().uuid()).min(1).max(1000),
  /** Kto potwierdza: nazwa procesu albo systemu, który skasował bajty. */
  confirmedBy: z.string().trim().min(1).max(191),
})

export type ConfirmDeletionInput = z.infer<typeof confirmDeletionSchema>

const confirmDeletionCommand: CommandHandler<ConfirmDeletionInput, { confirmed: number; rejected: string[] }> = {
  id: 'vision.clips.confirm_deletion',
  async execute(rawInput, ctx) {
    const input = confirmDeletionSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const now = new Date()

    const clips = (await em.find(Clip, {
      tenantId: input.tenantId,
      id: { $in: input.clipIds },
    } as never)) as unknown as Array<{
      id: string
      markedForDeletionAt?: Date | null
      deletionConfirmedAt?: Date | null
      deletionConfirmedBy?: string | null
    }>

    const rejected: string[] = []
    let confirmed = 0

    for (const clip of clips) {
      if (!clip.markedForDeletionAt) {
        /*
         * Potwierdzenie usunięcia czegoś, czego nikt nie oznaczył, znaczy,
         * że materiał skasowano poza procesem - może przed terminem, może
         * mimo wstrzymania dowodowego. Odmawiamy i zwracamy listę, zamiast
         * przyjąć zapis, który zamyka sprawę wyglądającą na zamkniętą.
         */
        rejected.push(clip.id)
        continue
      }
      if (clip.deletionConfirmedAt) continue
      clip.deletionConfirmedAt = now
      clip.deletionConfirmedBy = input.confirmedBy
      confirmed += 1
    }
    await em.flush()

    if (confirmed > 0 || rejected.length > 0) {
      await emitVisionEvent('vision.clips.deletion_confirmed', {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        confirmed,
        // Odrzucone jadą w ładunku, bo znaczą coś gorszego niż brak
        // potwierdzenia: materiał skasowano poza procesem.
        rejected,
        confirmedBy: input.confirmedBy,
      })
    }

    return { confirmed, rejected }
  },
}

registerCommand(confirmDeletionCommand)
registerCommand(registerCameraCommand)
registerCommand(registerDetectorCommand)
registerCommand(recordWindowCommand)
registerCommand(attachClipCommand)
registerCommand(purgeClipsCommand)

export {
  confirmDeletionCommand,
  registerCameraCommand,
  registerDetectorCommand,
  recordWindowCommand,
  attachClipCommand,
  purgeClipsCommand,
}

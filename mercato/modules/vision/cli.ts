import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ensureClipsPurgeSchedule } from './setup'
import { contamination, triangulate } from './lib/triangulate'

/** Komendy operatorskie wzroku maszynowego. */

type Scope = { tenantId: string; organizationId: string }

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [key, value] = part.slice(2).split('=')
    if (value !== undefined) args[key] = value
    else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) {
      args[key] = rest[index + 1]!
      index += 1
    } else args[key] = true
  }
  return args
}

async function resolveScope(em: EntityManager, args: Record<string, string | boolean>): Promise<Scope> {
  const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
  const organizationId = typeof args.org === 'string' ? args.org : ''
  if (tenantId && organizationId) return { tenantId, organizationId }
  const rows = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select tenant_id, id from organizations where deleted_at is null order by created_at asc limit 1',
  )
  if (!rows?.length) throw new Error('Brak organizacji - uruchom najpierw inicjalizację aplikacji.')
  return { tenantId: rows[0].tenant_id, organizationId: rows[0].id }
}

function buildCommandContext(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  scope: Scope,
): CommandRuntimeContext {
  // Pełny kształt zakresu - nauczka z modułu `work_orders`.
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as unknown as CommandRuntimeContext
}

const proveCommand: ModuleCli = {
  command: 'prove',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const bus = container.resolve('commandBus') as CommandBus
    const ctx = buildCommandContext(container, scope)
    const stamp = Date.now().toString(36)

    const cele = await em.getConnection().execute<Array<{ id: string; name: string }>>(
      'select id, name from fleet_cells where tenant_id = ? and deleted_at is null order by code limit 1',
      [scope.tenantId],
    )
    if (!cele.length) {
      console.log('Brak celi. Uruchom: yarn mercato fleet seed')
      return
    }
    const cela = cele[0]

    console.log('DOWÓD WZROKU - trzeci świadek, który umie być podejrzanym\n')

    /* ---------- 1. Dwie odmowy ---------- */
    console.log('1) Czego ten moduł nie przyjmie\n')

    const dzien = 24 * 3600_000
    try {
      await bus.execute('vision.cameras.register', {
        input: {
          ...scope,
          cellId: cela.id,
          code: `ODMOWA-A-${stamp}`,
          name: 'Kamera z rocznym przechowywaniem',
          viewRole: 'cell_overview',
          purpose: 'production_control',
          retentionDays: 365,
          peopleInView: true,
        },
        ctx,
      })
      console.log('   !! kamera z rocznym przechowywaniem PRZESZŁA - to jest błąd')
    } catch (error) {
      console.log(`   odmowa: ${(error as Error).message.slice(0, 160)}`)
    }

    try {
      await bus.execute('vision.detectors.register', {
        input: {
          ...scope,
          detectorKey: `odmowa-${stamp}`,
          revision: 1,
          name: 'Detektor nastroju operatora',
          weightsDigest: createHash('sha256').update('x').digest('hex'),
          classVocabulary: ['pet', 'worker_emotion'],
          confidenceThreshold: 0.5,
        },
        ctx,
      })
      console.log('   !! detektor emocji PRZESZEDŁ - to jest błąd')
    } catch (error) {
      console.log(`   odmowa: ${(error as Error).message.slice(0, 200)}`)
    }

    /* ---------- 2. Rejestracja zgodna z prawem ---------- */
    const kamera = (
      await bus.execute('vision.cameras.register', {
        input: {
          ...scope,
          cellId: cela.id,
          code: `BIN-CAM-${stamp}`,
          name: 'Kamera nad pojemnikiem odkładczym',
          viewRole: 'bin_outfeed',
          // Kontrola produkcji - cel wprost z katalogu art. 22² § 1 KP.
          purpose: 'production_control',
          retentionDays: 14,
          peopleInView: true,
          workforceNotifiedAt: new Date(Date.now() - 30 * dzien),
          areaMarkedAt: new Date(Date.now() - 20 * dzien),
          resolution: '1920x1080',
          framesPerSecond: 30,
        },
        ctx,
      })
    ).result as { cameraId: string; warnings: string[] }

    const detektor = (
      await bus.execute('vision.detectors.register', {
        input: {
          ...scope,
          detectorKey: 'bin-material-yolo',
          revision: 1,
          name: 'Klasyfikacja frakcji nad pojemnikiem',
          weightsDigest: createHash('sha256').update('bin-material-yolo-r1').digest('hex'),
          classVocabulary: ['pet', 'pvc', 'hdpe', 'person'],
          confidenceThreshold: 0.55,
        },
        ctx,
      })
    ).result as { detectorVersionId: string; presenceOnly: string[] }

    console.log(`\n2) Zarejestrowano: kamera ${cela.name}, próg ufności 0,55`)
    console.log(`   klasy warunkowe: ${detektor.presenceOnly.join(', ') || '(brak)'} - wyłącznie obecność`)

    /* ---------- 3. Cztery zestawy trzech liczb ---------- */
    console.log('\n3) Ten sam robot, ta sama waga, różne odczyty kamery\n')

    const PET = 30
    const scenariusze = [
      { opis: 'wszystko się zgadza', wizja: 1000, robot: 1000, gramy: 30_000 },
      { opis: 'robot i wizja zgodni, waga niżej', wizja: 1000, robot: 1000, gramy: 24_000 },
      { opis: 'wizja i waga zgodne, robot wyżej', wizja: 800, robot: 1000, gramy: 24_000 },
      { opis: 'robot i waga zgodni, wizja niżej', wizja: 800, robot: 1000, gramy: 30_000 },
    ]

    const baza = Date.now() - 48 * 3600_000
    for (let i = 0; i < scenariusze.length; i += 1) {
      const s = scenariusze[i]
      const od = new Date(baza + i * 3600_000)
      const doo = new Date(od.getTime() + 1800_000)

      await bus.execute('vision.windows.record', {
        input: {
          ...scope,
          cameraId: kamera.cameraId,
          detectorVersionId: detektor.detectorVersionId,
          startedAt: od,
          endedAt: doo,
          framesAnalyzed: 54_000,
          // Ścieżki, nie detekcje: butelka widoczna w trzydziestu klatkach
          // to jeden obiekt, nie trzydzieści.
          countingMode: 'tracks',
          counts: { pet: s.wizja, pvc: Math.round(s.wizja * 0.04), person: 1 },
        },
        ctx,
      })

      const wynik = triangulate({
        depositedCount: s.wizja,
        claimedCount: s.robot,
        weighedGrams: s.gramy,
        nominalPieceGrams: PET,
      })
      const sklad = contamination({ pet: s.wizja, pvc: Math.round(s.wizja * 0.04), person: 1 }, 'pet')

      console.log(`   ${s.opis}`)
      console.log(`     wizja ${s.wizja} | robot ${s.robot} | masa ${wynik.massImpliedCount} szt.`)
      console.log(`     podejrzany: ${wynik.suspect}`)
      console.log(`     ${wynik.reason}`)
      if (wynik.cannotDistinguish.length) {
        console.log(`     czego to NIE rozstrzyga: ${wynik.cannotDistinguish[0]}`)
      }
      if (i === 0) {
        console.log(
          `     skład pojemnika: ${((sklad.ratio ?? 0) * 100).toFixed(1)}% obcych frakcji ` +
            `(${Object.entries(sklad.byClass).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
        )
      }
      console.log('')
    }

    /* ---------- 4. Spięcie z prawdziwymi partiami roboczymi ---------- */
    const partie = await em.getConnection().execute<Array<{
      id: string
      container_code: string
      opened_at: string
      closed_at: string
      claimed_pieces: number | null
      cell_id: string
    }>>(
      `select b.id, b.container_code, b.opened_at, b.closed_at, b.claimed_pieces, o.cell_id
         from work_orders_batches b
         join work_orders_orders o on o.id = b.work_order_id
        where b.tenant_id = ? and b.status = 'closed' and o.cell_id = ?
        order by b.closed_at desc limit 2`,
      [scope.tenantId, cela.id],
    )

    if (!partie.length) {
      console.log('4) Brak zamkniętych partii roboczych - uruchom najpierw: yarn mercato work_orders prove\n')
    } else {
      console.log('4) Ten sam rachunek na prawdziwych partiach z modułu work_orders\n')
      /*
       * Zliczenia wizji są tu **wytworzone na potrzeby dowodu** i trzeba to
       * powiedzieć wprost: żadna kamera tego nie policzyła. Pokazujemy, że
       * łączenie po celi i oknie czasowym działa na rzeczywistych partiach,
       * a nie że mamy prawdziwy wzrok maszynowy.
       */
      const udzial = [1.0, 0.8]
      for (let i = 0; i < partie.length; i += 1) {
        const partia = partie[i]
        const zgloszone = Number(partia.claimed_pieces ?? 0)
        const wizja = Math.round(zgloszone * (udzial[i] ?? 1))
        /*
         * Okno wizji liczone z **rzeczywistego czasu trwania partii**, a nie
         * ze stałego przesunięcia. Wersja ze stałą (otwarcie + minuta, dziesięć
         * minut długości) wypadała poza partie krótsze niż minuta i dowód
         * pokazywał „brak trzeciego świadka" tam, gdzie właśnie go dołożył.
         *
         * To trzecie wystąpienie tej samej klasy błędu w tym projekcie -
         * po fazie 4 i po moście do ERP. Wniosek jest za każdym razem ten sam:
         * okno wyprowadzać z danych, nigdy z zegara ani ze stałej.
         */
        const otwarcie = new Date(partia.opened_at).getTime()
        const zamkniecie = new Date(partia.closed_at).getTime()
        const trwanie = Math.max(1000, zamkniecie - otwarcie)
        const od = new Date(otwarcie + Math.floor(trwanie * 0.1))
        const doo = new Date(otwarcie + Math.floor(trwanie * 0.9))

        await bus.execute('vision.windows.record', {
          input: {
            ...scope,
            cameraId: kamera.cameraId,
            detectorVersionId: detektor.detectorVersionId,
            startedAt: od,
            endedAt: doo,
            framesAnalyzed: 18_000,
            countingMode: 'tracks',
            counts: { pet: wizja, pvc: Math.round(wizja * 0.04) },
          },
          ctx,
        })
        console.log(`   ${partia.container_code}: wizja ${wizja} wobec ${zgloszone} zgłoszonych przez robota`)
      }
      console.log('\n   (zliczenia wytworzone na potrzeby dowodu - żadna kamera ich nie policzyła;')
      console.log('    sprawdzane jest łączenie po celi i oknie czasowym, nie wzrok maszynowy)\n')
    }

    console.log('Wniosek: dwaj świadkowie mówią, ŻE coś się nie zgadza.')
    console.log('Trzeci zaczyna mówić, GDZIE - i sam bywa podejrzanym (scenariusz czwarty).')
  },
}

const triangulateCommand: ModuleCli = {
  command: 'triangulate',
  async run(rest) {
    const args = parseArgs(rest)
    const kod = typeof args.container === 'string' ? args.container : ''
    if (!kod) throw new Error('Podaj: --container <etykieta partii roboczej>')

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const partie = await em.getConnection().execute<Array<{
      container_code: string
      opened_at: string
      closed_at: string | null
      claimed_pieces: number | null
      weighed_grams: string | null
      nominal_piece_grams: number | null
      cell_id: string
      sku: string
    }>>(
      `select b.container_code, b.opened_at, b.closed_at, b.claimed_pieces, b.weighed_grams,
              o.nominal_piece_grams, o.cell_id, o.sku
         from work_orders_batches b
         join work_orders_orders o on o.id = b.work_order_id
        where b.tenant_id = ? and b.container_code = ?
        order by b.opened_at desc limit 1`,
      [scope.tenantId, kod],
    )
    if (!partie.length) throw new Error(`Nie ma partii o etykiecie ${kod}.`)
    const p = partie[0]
    if (!p.closed_at) throw new Error('Partia jest jeszcze otwarta - nie ma masy z wagi.')

    /*
     * Zliczenia wizji z okna partii. Sumujemy po klasie odpowiadającej frakcji
     * zlecenia; okna wiąże z partią ten sam mechanizm, co epizody - czas i cela.
     */
    const okna = await em.getConnection().execute<Array<{ counts: Record<string, number>; counting_mode: string }>>(
      `select w.counts, w.counting_mode
         from vision_detection_windows w
         join vision_cameras c on c.id = w.camera_id
        where w.tenant_id = ? and w.cell_id = ?
          and c.view_role = 'bin_outfeed'
          and w.started_at >= ? and w.started_at < ?`,
      [scope.tenantId, p.cell_id, p.opened_at, p.closed_at],
    )

    const tryby = new Set(okna.map((o) => o.counting_mode))
    if (tryby.size > 1) {
      // Zliczenia ścieżek i detekcji nie sumują się do jednej liczby.
      throw new Error('Okna w tym przedziale mieszają tryby zliczania (ścieżki i detekcje) - suma byłaby bez sensu.')
    }

    const razem: Record<string, number> = {}
    for (const okno of okna) {
      for (const [klasa, liczba] of Object.entries(okno.counts ?? {})) {
        razem[klasa] = (razem[klasa] ?? 0) + Number(liczba || 0)
      }
    }

    const klasaFrakcji = typeof args.class === 'string' ? args.class : 'pet'
    const deposited = okna.length ? (razem[klasaFrakcji] ?? 0) : null
    const wynik = triangulate({
      depositedCount: deposited,
      claimedCount: Number(p.claimed_pieces ?? 0),
      weighedGrams: Number(p.weighed_grams ?? 0),
      nominalPieceGrams: p.nominal_piece_grams,
    })
    const sklad = contamination(razem, klasaFrakcji)

    console.log(`Partia     : ${p.container_code} (frakcja ${p.sku})`)
    console.log(`Okien wizji: ${okna.length}${okna.length ? ` (tryb: ${[...tryby][0]})` : ' - brak trzeciego świadka'}`)
    console.log(`Wizja      : ${deposited ?? '-'}`)
    console.log(`Robot      : ${p.claimed_pieces ?? 0}`)
    console.log(`Masa       : ${(Number(p.weighed_grams ?? 0) / 1000).toFixed(2)} kg → ${wynik.massImpliedCount ?? '-'} szt.`)
    console.log(`Podejrzany : ${wynik.suspect}`)
    console.log(`             ${wynik.reason}`)
    if (sklad.ratio !== null) {
      console.log(`Skład      : ${(sklad.ratio * 100).toFixed(1)}% obcych frakcji`)
    }
    for (const granica of wynik.cannotDistinguish) console.log(`Nie rozstrzyga: ${granica}`)
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const kamery = await em.getConnection().execute<Array<{
      code: string
      view_role: string
      purpose: string
      retention_days: number
      cell: string | null
      windows: string
      notified: string | null
      marked: string | null
      people_in_view: boolean
    }>>(
      `select c.code, c.view_role, c.purpose, c.retention_days, fc.name as cell,
              c.workforce_notified_at as notified, c.area_marked_at as marked, c.people_in_view,
              (select count(*) from vision_detection_windows w where w.camera_id = c.id) as windows
         from vision_cameras c
         left join fleet_cells fc on fc.id = c.cell_id
        where c.tenant_id = ? and c.deleted_at is null
        order by c.code`,
      [scope.tenantId],
    )

    if (!kamery.length) {
      console.log('Brak kamer.')
      return
    }

    console.log('  kod              widok          cel                 dni  okien  zgodność formalna')
    console.log('  ' + '-'.repeat(84))
    for (const k of kamery) {
      const braki: string[] = []
      if (k.people_in_view && !k.notified) braki.push('brak informacji dla załogi')
      if (k.people_in_view && !k.marked) braki.push('brak oznaczenia obszaru')
      console.log(
        `  ${k.code.padEnd(17)}${k.view_role.padEnd(15)}${k.purpose.padEnd(20)}${String(k.retention_days).padEnd(5)}` +
          `${String(k.windows).padEnd(7)}${braki.length ? '!! ' + braki.join(', ') : 'w porządku'}`,
      )
    }

    const klipy = await em.getConnection().execute<Array<{
      po_terminie: string
      wstrzymane: string
      nieusuniete: string
      razem: string
    }>>(
      `select count(*) filter (where delete_after <= now() and marked_for_deletion_at is null and legal_hold_reference is null) as po_terminie,
              count(*) filter (where legal_hold_reference is not null and marked_for_deletion_at is null) as wstrzymane,
              count(*) filter (where marked_for_deletion_at is not null and deletion_confirmed_at is null) as nieusuniete,
              count(*) as razem
         from vision_clips where tenant_id = ?`,
      [scope.tenantId],
    )
    const k = klipy[0]
    console.log(`\n  klipy: ${k.razem} łącznie, ${k.po_terminie} po terminie i nieoznaczonych, ${k.wstrzymane} wstrzymanych jako dowód`)
    /*
     * Właściwa liczba zgodności: oznaczone, ale nadal istniejące. Liczba
     * oznaczeń sama w sobie nie mówi nic - z punktu widzenia art. 22² § 3 KP
     * nagranie, którego nikt nie skasował, wciąż tam jest.
     */
    if (Number(k.nieusuniete) > 0) {
      console.log(`  !! ${k.nieusuniete} oznaczonych, ale NIEUSUNIĘTYCH - materiał po terminie nadal istnieje`)
      console.log('     zgodność zamyka dopiero potwierdzenie z magazynu obiektów')
    }
    if (Number(k.po_terminie) > 0) console.log('  → harmonogram oznacza je automatycznie co 24 h')
  },
}


/**
 * Potwierdzenie usunięcia bajtów.
 *
 * Wołane przez ten system albo proces, który naprawdę skasował pliki
 * z magazynu obiektów. Do tego momentu materiał jest **oznaczony i nadal
 * istniejący** - a z punktu widzenia art. 22² § 3 Kodeksu pracy to znaczy,
 * że nagranie wciąż tam jest.
 */
const confirmCommand: ModuleCli = {
  command: 'confirm',
  async run(rest) {
    const args = parseArgs(rest)
    const by = typeof args.by === 'string' ? args.by : ''
    if (!by) throw new Error('Podaj, kto potwierdza usunięcie: --by <nazwa systemu>')

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const bus = container.resolve('commandBus') as CommandBus

    const jawne = typeof args.clips === 'string' ? args.clips.split(',').map((s) => s.trim()).filter(Boolean) : []
    const identyfikatory = jawne.length
      ? jawne
      : (
          await em.getConnection().execute<Array<{ id: string }>>(
            `select id from vision_clips
              where tenant_id = ? and marked_for_deletion_at is not null and deletion_confirmed_at is null
              limit 1000`,
            [scope.tenantId],
          )
        ).map((r) => r.id)

    if (!identyfikatory.length) {
      console.log('Brak materiału oznaczonego i nieusuniętego - nie ma czego potwierdzać.')
      return
    }

    const envelope = await bus.execute('vision.clips.confirm_deletion', {
      input: { ...scope, clipIds: identyfikatory, confirmedBy: by },
      ctx: buildCommandContext(container, scope),
    })
    const result = envelope.result as { confirmed: number; rejected: string[] }

    console.log(`Potwierdzono usunięcie: ${result.confirmed}`)
    if (result.rejected.length) {
      console.log(`Odrzucono ${result.rejected.length} - materiał nieoznaczony, czyli skasowany poza procesem.`)
    }
  },
}


/**
 * Rejestracja harmonogramu w tenancie, który już istnieje.
 *
 * Platforma woła `seedDefaults` wyłącznie przy inicjalizacji tenanta, więc
 * moduł **doinstalowany później nigdy nie zarejestrowałby swojego zadania
 * cyklicznego** - i nikt by tego nie zauważył, bo brak zadania nie generuje
 * błędu, tylko ciszę. Ta komenda domyka tę lukę i jest idempotentna:
 * identyfikator harmonogramu jest stały, a `register` nadpisuje.
 */
const installSchedulesCommand: ModuleCli = {
  command: 'install-schedules',
  async run(_rest) {
    const container = await createRequestContainer()
    await ensureClipsPurgeSchedule(container as unknown as import('awilix').AwilixContainer)
    console.log('Harmonogram oznaczania materiału po terminie: zarejestrowany (albo już był).')
    console.log('Sprawdzenie: yarn mercato scheduler list')
  },
}

const purgeCommand: ModuleCli = {
  command: 'purge',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const bus = container.resolve('commandBus') as CommandBus

    const envelope = await bus.execute('vision.clips.purge', {
      input: scope,
      ctx: buildCommandContext(container, scope),
    })
    const result = envelope.result as { purged: Array<{ uri: string }>; heldBack: number }

    console.log(`Oznaczono do usunięcia: ${result.purged.length}`)
    for (const clip of result.purged.slice(0, 20)) console.log(`  ${clip.uri}`)
    if (result.heldBack) console.log(`Wstrzymanych jako dowód w postępowaniu: ${result.heldBack}`)
    console.log('\nPlików nie kasuje ta platforma - kasuje ten, kto je trzyma.')
    console.log('Wpis w bazie mówi „ten plik ma zniknąć", nie „ten plik zniknął".')
    console.log('Zgodność zamyka: mercato vision confirm --by <system> --clips <id,...>')
  },
}

export default [proveCommand, triangulateCommand, statusCommand, purgeCommand, confirmCommand, installSchedulesCommand] satisfies ModuleCli[]

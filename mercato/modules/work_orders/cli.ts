import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { User } from '@open-mercato/core/modules/auth/data/entities'

/**
 * Komendy operatorskie mostu.
 *
 * `weigh` jest tą, której używa człowiek na hali: pojemnik staje na wadze,
 * wpisuje się kilogramy. Reszta dzieje się sama - partia magazynowa, przyjęcie
 * i uzgodnienie z deklaracją robota.
 */

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
  /**
   * Pełny kształt zakresu, nie skrócony.
   *
   * Osiem modułów robotycznych wołało dotąd wyłącznie własne komendy i uszło im
   * płazem `{ selectedId, filterIds }`. Ten moduł jako pierwszy woła komendy
   * rdzenia platformy (`wms.lots.create`, `wms.inventory.receive`), a te
   * sprawdzają zakres przez `allowedIds` i `tenantId` - skrócony kształt
   * kończy się na nich odmową `Forbidden` bez wskazania przyczyny.
   *
   * Ten sam komplet pól niesie moduł `sortownia`, bo on od początku pisał
   * do magazynu platformy.
   */
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

/**
 * Użytkownik, na którego konto idą ruchy magazynowe z wiersza poleceń.
 *
 * Wiersz poleceń nie ma sesji, a magazyn wymaga wykonawcy. Zamiast
 * podstawiać kogokolwiek po cichu, komenda **wypisuje**, komu przypisała
 * ruch - w prawdziwym wdrożeniu waży zalogowany człowiek, a nie skrypt.
 */
async function resolveOperator(em: EntityManager, scope: Scope, args: Record<string, string | boolean>): Promise<{ id: string; email: string }> {
  /*
   * Adresy użytkowników są szyfrowane w spoczynku, więc surowy SELECT zwraca
   * szyfrogram i wypisałby go operatorowi na ekran. Ta sama pomyłka złapana
   * już raz w pulpicie sortowni - odczyt idzie `findWithDecryption`.
   */
  const wanted = typeof args.as === 'string' ? args.as : null
  const users = (await findWithDecryption(em, User, { tenantId: scope.tenantId } as never, {
    orderBy: { createdAt: 'asc' },
  } as never)) as unknown as Array<{ id: string; email: string }>

  if (!users?.length) throw new Error('Brak użytkownika w tenancie - nie ma komu przypisać ruchów magazynowych.')
  const chosen = wanted ? users.find((u) => u.email === wanted) : users[0]
  if (!chosen) throw new Error(`Nie ma użytkownika ${wanted}.`)
  return { id: chosen.id, email: chosen.email }
}

function kg(grams: number): string {
  return (grams / 1000).toFixed(2)
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)

    const rows = await em.getConnection().execute<Array<{
      order_number: string
      sku: string
      status: string
      cell: string | null
      target_grams: string
      produced_grams: string | null
      batches: string
      drift_grams: string | null
      overclaim: string
    }>>(
      `select o.order_number, o.sku, o.status, c.name as cell, o.target_grams,
              b.produced_grams, b.batches, r.drift_grams, r.overclaim
         from work_orders_orders o
         left join fleet_cells c on c.id = o.cell_id
         left join lateral (
              select sum(wb.weighed_grams) filter (where wb.status = 'closed') as produced_grams,
                     count(*) filter (where wb.status = 'closed') as batches
                from work_orders_batches wb where wb.work_order_id = o.id
         ) b on true
         left join lateral (
              select sum(x.drift_grams) as drift_grams,
                     count(*) filter (where x.verdict = 'overclaim') as overclaim
                from (select distinct on (rec.batch_id) rec.drift_grams, rec.verdict
                        from work_orders_reconciliations rec
                        join work_orders_batches wb2 on wb2.id = rec.batch_id
                       where wb2.work_order_id = o.id
                       order by rec.batch_id, rec.computed_at desc) x
         ) r on true
        where o.tenant_id = ?
        order by o.opened_at desc limit 50`,
      [scope.tenantId],
    )

    if (!rows.length) {
      console.log('Brak zleceń roboczych.')
      return
    }

    console.log('  zlecenie            frakcja    stan        wyprodukowano   rozjazd')
    console.log('  ' + '-'.repeat(78))
    for (const row of rows) {
      const drift = row.drift_grams === null ? '-' : `${kg(Number(row.drift_grams))} kg`
      /*
       * Liczba partii, nie sam wykrzyknik. Rozjazd zbiorczy potrafi wyjść
       * dodatni, gdy jedna partia miała nadwyżkę, a druga niedobór - i wtedy
       * „brakuje materiału" obok dodatniej liczby wyglądało na sprzeczność,
       * choć flaga była poprawna. Wydruk ma mówić, ile partii, a nie sugerować
       * kierunek sumy.
       */
      const ileOverclaim = Number(row.overclaim ?? 0)
      const flaga = ileOverclaim > 0 ? `  !! ${ileOverclaim} partii z niedoborem` : ''
      console.log(
        `  ${row.order_number.padEnd(20)}${row.sku.padEnd(11)}${row.status.padEnd(12)}` +
          `${(kg(Number(row.produced_grams ?? 0)) + ' / ' + kg(Number(row.target_grams))).padEnd(16)}${drift}${flaga}`,
      )
    }
  },
}

const weighCommand: ModuleCli = {
  command: 'weigh',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const bus = container.resolve('commandBus') as CommandBus

    const containerCode = typeof args.container === 'string' ? args.container : ''
    const kilograms = Number(args.kg ?? NaN)
    if (!containerCode || !Number.isFinite(kilograms)) {
      throw new Error('Podaj: --container <etykieta> --kg <masa z wagi>')
    }

    const batches = await em.getConnection().execute<Array<{ id: string }>>(
      `select id from work_orders_batches
        where tenant_id = ? and container_code = ? and status = 'filling' limit 1`,
      [scope.tenantId, containerCode],
    )
    if (!batches.length) throw new Error(`Brak otwartej partii o etykiecie ${containerCode}.`)

    const operator = await resolveOperator(em, scope, args)
    const envelope = await bus.execute('work_orders.batches.close', {
      input: {
        ...scope,
        batchId: batches[0].id,
        performedBy: operator.id,
        // Gramy jako liczba całkowita - kilogramy zmiennoprzecinkowe kończą się
        // bilansem, który nie domyka się o kilkaset gramów na tysiąc ruchów.
        weighedGrams: Math.round(kilograms * 1000),
      },
      ctx: buildCommandContext(container, scope),
    })

    const result = envelope.result as {
      claimedPieces: number
      expectedGrams: number | null
      weighedGrams: number
      driftGrams: number | null
      verdict: string
      reason: string
      requiresReview: boolean
      lotNumber: string | null
    }

    console.log(`Pojemnik   : ${containerCode}`)
    console.log(`Zważył     : ${operator.email}`)
    console.log(`Waga       : ${kg(result.weighedGrams)} kg`)
    console.log(`Deklaracja : ${result.claimedPieces} chwytów` +
      (result.expectedGrams === null ? '' : ` = ${kg(result.expectedGrams)} kg`))
    console.log(`Werdykt    : ${result.verdict}`)
    console.log(`             ${result.reason}`)
    if (result.lotNumber) console.log(`Partia WMS : ${result.lotNumber}`)
    if (result.requiresReview) {
      console.log('\nFlaga dotyczy MASZYNY, nie materiału: masa weszła do magazynu,')
      console.log('bo fizycznie leży w pojemniku. Sprawdzić chwytak albo czujnik.')
    }
  },
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

    const kontekst = await em.getConnection().execute<Array<{
      robot_id: string
      cell_id: string
      cell: string
      variant_id: string
      sku: string
      warehouse_id: string
      location_id: string
    }>>(
      `select r.id as robot_id, c.id as cell_id, c.name as cell,
              v.id as variant_id, v.sku,
              w.id as warehouse_id, l.id as location_id
         from fleet_robots r
         join fleet_cells c on c.id = r.cell_id
         cross join lateral (select id, sku from catalog_product_variants
                              where tenant_id = r.tenant_id and sku = '20 01 01' limit 1) v
         cross join lateral (select id from wms_warehouses where tenant_id = r.tenant_id limit 1) w
         cross join lateral (select id from wms_warehouse_locations wl
                              where wl.warehouse_id = (select id from wms_warehouses where tenant_id = r.tenant_id limit 1)
                              limit 1) l
        where r.tenant_id = ? and r.state = 'operational' and r.deleted_at is null
        order by r.serial_number limit 1`,
      [scope.tenantId],
    )
    if (!kontekst.length) {
      console.log('Brak kompletu danych. Wymagane: flota (fleet seed) i dane sortowni (frakcja 20 01 01, magazyn).')
      return
    }
    const k = kontekst[0]
    const operator = await resolveOperator(em, scope, args)

    console.log('DOWÓD MOSTU - waga rozstrzyga o zapasie, deklaracja robota o ocenie robota\n')
    console.log(`   cela ${k.cell}, frakcja ${k.sku}, waży ${operator.email}`)

    const PET_GRAMOW = 30
    const order = (
      await bus.execute('work_orders.orders.open', {
        input: {
          ...scope,
          orderNumber: `ZR/${stamp}`,
          cellId: k.cell_id,
          catalogVariantId: k.variant_id,
          sku: k.sku,
          warehouseId: k.warehouse_id,
          locationId: k.location_id,
          targetGrams: 60_000,
          nominalPieceGrams: PET_GRAMOW,
        },
        ctx,
      })
    ).result as { workOrderId: string }
    console.log(`   zlecenie ZR/${stamp}, cel 60,00 kg, masa nominalna sztuki ${PET_GRAMOW} g`)

    /**
     * Napełnia pojemnik w **jawnym oknie czasowym**, nie „od teraz do teraz".
     *
     * Pierwsza wersja rozstawiała epizody względem `openedAt`, a zamykała
     * partię bieżącym czasem - przez co okno zależało od tego, jak szybko
     * szyna komend przemieli tysiąc zapisów. Skutek: 749 epizodów partii A
     * wypadło poza jej okno i doliczyło się do partii B, a dowód mierzył
     * wydajność maszyny, na której akurat działa, zamiast zachowania systemu.
     *
     * Oś czasu jest teraz syntetyczna i cofnięta: partie stoją obok siebie
     * bez zakładki, a wynik nie zależy od czasu wykonania.
     */
    async function pojemnik(
      kod: string,
      chwyty: number,
      wagaGramy: number,
      okno: { od: Date; do: Date },
      opis: string,
    ): Promise<void> {
      const batch = (
        await bus.execute('work_orders.batches.open', {
          input: {
            ...scope,
            workOrderId: order.workOrderId,
            containerCode: `${kod}-${stamp}`,
            openedAt: okno.od,
          },
          ctx,
        })
      ).result as { batchId: string }

      // Epizody rozstawione równo w oknie, z zapasem na obu krańcach.
      const rozpietosc = okno.do.getTime() - okno.od.getTime() - 2000
      for (let i = 0; i < chwyty; i += 1) {
        const start = okno.od.getTime() + 1000 + Math.floor((rozpietosc * i) / Math.max(1, chwyty))
        await bus.execute('episodes.episodes.record', {
          input: {
            ...scope,
            robotId: k.robot_id,
            cellId: k.cell_id,
            externalRef: `${kod}-${stamp}-${i}`,
            taskKey: 'pick_pet_to_bin',
            startedAt: new Date(start),
            endedAt: new Date(start + 8),
            outcome: 'success',
          },
          ctx,
        })
      }

      const wynik = (
        await bus.execute('work_orders.batches.close', {
          input: {
            ...scope,
            batchId: batch.batchId,
            weighedGrams: wagaGramy,
            closedAt: okno.do,
            performedBy: operator.id,
          },
          ctx,
        })
      ).result as {
        claimedPieces: number
        expectedGrams: number | null
        driftGrams: number | null
        verdict: string
        requiresReview: boolean
        lotNumber: string | null
      }

      console.log(`\n${opis}`)
      console.log(
        `   deklaracja ${wynik.claimedPieces} chwytów = ${kg(wynik.expectedGrams ?? 0)} kg,` +
          ` waga ${kg(wagaGramy)} kg, rozjazd ${kg(wynik.driftGrams ?? 0)} kg`,
      )
      console.log(`   werdykt: ${wynik.verdict}${wynik.requiresReview ? '  → flaga na maszynę' : ''}`)
      console.log(`   do magazynu weszło: ${kg(wagaGramy)} kg jako ${wynik.lotNumber}`)
    }

    /**
     * Sprzątanie po poprzednim przebiegu dowodu.
     *
     * Liczba chwytów w partii to liczba epizodów sukcesu w **oknie czasowym**
     * celi - i tak ma być, bo w ruchu każdy epizod w tym oknie naprawdę trafił
     * do tego pojemnika. Skutkiem ubocznym jest to, że drugi przebieg dowodu
     * doliczał epizody pierwszego (2000 zamiast 1000) i pokazywał werdykt,
     * którego nie dotyczył.
     *
     * Usuwamy **wyłącznie epizody zapisane przez ten dowód**, rozpoznane po
     * przedrostku odniesienia zewnętrznego. Żadnych masowych kasowań i żadnego
     * dotykania epizodów z innego źródła - te same zasady, co przy poprawkach
     * w księdze ruchów magazynowych.
     */
    const usuniete = await em.getConnection().execute<Array<{ count: string }>>(
      `with skasowane as (
         delete from episodes_episodes
          where tenant_id = ? and cell_id = ?
            and (external_ref like 'BIN-A-%' or external_ref like 'BIN-B-%')
          returning 1
       ) select count(*) as count from skasowane`,
      [scope.tenantId, k.cell_id],
    )
    const ile = Number(usuniete?.[0]?.count ?? 0)
    if (ile > 0) console.log(`   (usunięto ${ile} epizodów z poprzedniego przebiegu dowodu)`)

    // Dwie zmiany po dwie godziny, wczoraj - żeby okna nie zahaczały o siebie
    // ani o bieżący czas.
    const baza = new Date(Date.now() - 24 * 3600_000)
    const oknoA = { od: baza, do: new Date(baza.getTime() + 2 * 3600_000) }
    const oknoB = {
      od: new Date(baza.getTime() + 2 * 3600_000),
      do: new Date(baza.getTime() + 4 * 3600_000),
    }

    await pojemnik('BIN-A', 1000, 29_400, oknoA, 'A) robot pracuje poprawnie')
    await pojemnik('BIN-B', 1000, 24_000, oknoB, 'B) robot gubi materiał, którego nie zgłasza jako porażki')

    const zamkniete = (
      await bus.execute('work_orders.orders.close', {
        input: { ...scope, workOrderId: order.workOrderId },
        ctx,
      })
    ).result as { producedGrams: number; batches: number }

    console.log(`\nZlecenie zamknięte: ${kg(zamkniete.producedGrams)} kg w ${zamkniete.batches} partiach.`)
    console.log('\nWniosek: obie partie weszły do magazynu w masie z wagi - bo materiał')
    console.log('fizycznie leży w pojemniku. Różnica między nimi nie jest w magazynie,')
    console.log('tylko w ocenie maszyny, i nie widać jej w żadnej telemetrii robota.')
  },
}

export default [statusCommand, weighCommand, proveCommand] satisfies ModuleCli[]

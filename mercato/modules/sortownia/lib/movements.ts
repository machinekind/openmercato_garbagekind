import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import {
  InventoryBalance,
  InventoryMovement,
  type WarehouseLocation,
} from '@open-mercato/core/modules/wms/data/entities'
import { legacyUuid, type LegacyMovementRow } from './legacyFiles'
import type { FractionIndex } from './fractions'

/**
 * Księga ruchów legacy przełożona na operacje WMS.
 *
 * Trzy rzeczy dzieją się tu naraz i każda z nich jest tym, czego stary system
 * nie potrafił:
 *
 * 1. `SORT` w legacy to PARA wierszy (minus na placu, plus w boksie), które
 *    nic nie wiąże poza tym, że mają tę samą sekundę. W WMS to jeden ruch
 *    `transfer` z `locationFrom` i `locationTo` - przesunięcie jest atomowe.
 * 2. `stkmoveno` wchodzi w deterministyczny `referenceId`, z którego WMS buduje
 *    `idempotency_key` pilnowany unikalnym indeksem. Powtórzony import odbija
 *    się od bazy, a nie od naszej pamięci.
 * 3. Masy jadą w kilogramach, bo w takich jednostkach prowadzony jest magazyn;
 *    megagramy są przeliczane na ekranach i w raportach.
 * 4. Od chwili, gdy przyjęcie zakłada partię, WMS prowadzi saldo OSOBNO dla
 *    każdej partii. Wysortowanie i wydanie zdejmują masę, która leży w kilku
 *    partiach naraz, więc jeden wiersz legacy bywa kilkoma ruchami WMS -
 *    po jednym na każdą ruszoną partię, najstarsze pierwsze.
 */

export type MovementOutcome = {
  externalId: string
  action: 'create' | 'skip' | 'failed'
  error?: string
  /** Numer ruchu legacy, do przesunięcia kursora. */
  stkmoveno: number
}

export type MovementContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  warehouseId: string
  locations: Map<string, WarehouseLocation>
  fractions: FractionIndex
  performedBy: string
  /**
   * `orderno` → identyfikator zamówienia sprzedaży w Mercato.
   *
   * Pozwala wydaniu wskazać dokument, który je zleca. Pusty indeks jest
   * poprawny: import ruchów wolno puścić bez modułu sprzedaży, wtedy korekta
   * zostaje samą korektą, tak jak było wcześniej.
   */
  salesOrders?: Map<number, string>
  /**
   * `stkmoveno` przyjęcia → identyfikator partii w WMS.
   *
   * Pusty indeks jest poprawny: import ruchów wolno puścić bez partii, wtedy
   * przyjęcie zostaje bezimienną masą, tak jak w starym systemie.
   */
  lots?: Map<number, string>
}

/** Para wierszy SORT: zejście z placu i przyjęcie na boks. */
type SortPair = { out: LegacyMovementRow; in: LegacyMovementRow }

/**
 * Składa wiersze SORT w pary. Kluczem jest frakcja, czas i wartość bezwzględna
 * ilości - dokładnie to, co w legacy „wiąże" oba wiersze nieformalnie.
 * Wiersz bez pary zostaje zgłoszony jako błąd pozycji, nie wywraca importu.
 */
export function pairSortRows(rows: LegacyMovementRow[]): { pairs: SortPair[]; orphans: LegacyMovementRow[] } {
  const pending = new Map<string, LegacyMovementRow[]>()
  const pairs: SortPair[] = []
  const orphans: LegacyMovementRow[] = []

  const keyOf = (row: LegacyMovementRow) => `${row.stockid}|${row.data}|${Math.abs(row.iloscKg).toFixed(2)}`

  for (const row of rows) {
    const key = keyOf(row)
    const bucket = pending.get(key) ?? []
    const counterpartIndex = bucket.findIndex((candidate) =>
      row.iloscKg < 0 ? candidate.iloscKg > 0 : candidate.iloscKg < 0,
    )
    if (counterpartIndex === -1) {
      bucket.push(row)
      pending.set(key, bucket)
      continue
    }
    const [counterpart] = bucket.splice(counterpartIndex, 1)
    pending.set(key, bucket)
    pairs.push(
      row.iloscKg < 0 ? { out: row, in: counterpart } : { out: counterpart, in: row },
    )
  }

  for (const bucket of pending.values()) orphans.push(...bucket)
  return { pairs, orphans }
}

/** Masy poniżej tego progu to szum zmiennoprzecinkowy, nie odpad. */
const EPSILON_KG = 0.000001

/** Kawałek masy zdjęty z jednej partii. */
type LotSlice = { lotId?: string; quantity: number }

/**
 * Ile masy z tego wiersza legacy już siedzi w księdze WMS.
 *
 * Pytanie „czy ten wiersz już wszedł" ma odpowiedź ilościową, nie logiczną,
 * bo jeden wiersz bywa kilkoma ruchami - po jednym na ruszoną partię. Przerwany
 * import dokłada wtedy brakującą resztę, zamiast uznać wiersz za zrobiony
 * (i zgubić masę) albo powtórzyć go w całości (i ją zdublować).
 *
 * Rozstrzyga `referenceId` - nasz własny, deterministyczny odcisk `stkmoveno`,
 * który nie zmienia się nigdy. Klucz idempotencji WMS obejmuje `lotId` oraz
 * ilość, więc sam w sobie nie odpowiada na pytanie o wiersz legacy: po zmianie
 * podziału na partie ten sam wiersz policzyłby się jako nowy.
 */
async function appliedQuantity(
  ctx: MovementContext,
  referenceId: string,
  type: 'receipt' | 'transfer' | 'adjust',
): Promise<number> {
  const existing = await ctx.em.find(
    InventoryMovement,
    {
      referenceId,
      type,
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
    } as never,
    // Komendy WMS zapisują we własnej transakcji; mapa tożsamości EM mogłaby
    // pamiętać stan sprzed niej, a wtedy powtórzony import dołożyłby masę
    // drugi raz.
    { refresh: true } as never,
  )
  return existing.reduce((sum, movement) => sum + Math.abs(Number(movement.quantity ?? 0)), 0)
}

/**
 * Rozkłada masę na partie leżące w lokalizacji - najstarsze pierwsze (FIFO).
 *
 * Powód jest twardy: `wms.inventory.move` i `wms.inventory.adjust` rozwiązują
 * saldo DOKŁADNIE (`findExactBalanceForUpdate`), a `lotId` jest częścią jego
 * tożsamości. Ruch bez partii trafia więc w saldo bezpartyjne - zerowe, odkąd
 * przyjęcia księgują masę na partie - i wraca z `insufficient_stock`, choć
 * odpad fizycznie leży. Platforma nie ma tu wyboru partii po strategii:
 * schemat komendy przyjmuje jedno, opcjonalne `lotId`.
 *
 * FIFO liczymy po dacie przyjęcia partii (`manufacturedAt`, czyli data `PZ`
 * w legacy), a nie po kolejności zapisu do bazy: w gospodarce odpadami liczy
 * się, jak długo masa leży na placu. Masa bez partii pochodzi sprzed wdrożenia
 * partii, więc w kolejce FIFO jest najstarsza.
 *
 * Bierzemy `quantityAvailable`, nie `quantityOnHand` - masa zarezerwowana pod
 * odbiór nie jest do ruszenia i to samo sprawdzenie zrobi zaraz WMS.
 */
async function sliceByLots(
  ctx: MovementContext,
  locationId: string,
  variantId: string,
  quantity: number,
): Promise<LotSlice[]> {
  const balances = await ctx.em.find(
    InventoryBalance,
    {
      location: locationId,
      catalogVariantId: variantId,
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
    } as never,
    { populate: ['lot'] } as never,
  )

  const dostepne = balances
    .map((balance) => ({ lot: balance.lot ?? null, quantity: Number(balance.quantityAvailable ?? 0) }))
    .filter((entry) => entry.quantity > EPSILON_KG)
    .sort((a, b) => {
      const left = a.lot?.manufacturedAt?.getTime() ?? 0
      const right = b.lot?.manufacturedAt?.getTime() ?? 0
      if (left !== right) return left - right
      // Numer partii niesie `stkmoveno`, więc rozstrzyga remisy w tej samej
      // sekundzie deterministycznie - ten sam zbiór dzieli się zawsze tak samo.
      return (a.lot?.lotNumber ?? '').localeCompare(b.lot?.lotNumber ?? '')
    })

  const slices: LotSlice[] = []
  let left = quantity
  for (const entry of dostepne) {
    if (left <= EPSILON_KG) break
    const take = Math.min(entry.quantity, left)
    slices.push({ lotId: entry.lot?.id, quantity: take })
    left -= take
  }

  if (left > EPSILON_KG) {
    const suma = dostepne.reduce((sum, entry) => sum + entry.quantity, 0)
    throw new Error(
      `insufficient_stock: potrzeba ${quantity.toFixed(2)} kg, w partiach dostępne ${suma.toFixed(2)} kg`,
    )
  }
  return slices
}

function parseMoment(value: string): Date {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

async function applyReceipt(ctx: MovementContext, row: LegacyMovementRow): Promise<boolean> {
  const location = ctx.locations.get(row.loccode.toUpperCase())
  const fraction = ctx.fractions.get(row.stockid)
  if (!location) throw new Error(`Nieznana lokalizacja legacy: ${row.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${row.stockid}`)

  const performedAt = parseMoment(row.data)
  const referenceId = legacyUuid('movement', row.stkmoveno)
  const total = Math.abs(row.iloscKg)
  // Przyjęcie wskazuje partię, a `lotId` wchodzi do klucza idempotencji WMS,
  // więc rozstrzygamy po `referenceId` - patrz komentarz przy `appliedQuantity`.
  if ((await appliedQuantity(ctx, referenceId, 'receipt')) >= total - EPSILON_KG) {
    return true
  }

  const lotId = ctx.lots?.get(row.stkmoveno)
  await ctx.commandBus.execute('wms.inventory.receive', {
    input: {
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
      warehouseId: ctx.warehouseId,
      locationId: location.id,
      catalogVariantId: fraction.variantId,
      quantity: total,
      // Partia niesie dostawcę i datę przyjęcia - bez niej przyjęcie jest
      // bezimienną masą i nie da się odpowiedzieć, czyj odpad gdzie trafił.
      lotId,
      referenceType: 'po',
      referenceId,
      performedBy: ctx.performedBy,
      performedAt,
      receivedAt: performedAt,
      reason: `Przyjęcie odpadu z systemu legacy (PZ ${row.stkmoveno}${row.debtorno ? `, dostawca ${row.debtorno}` : ''})`,
      metadata: {
        legacy: { stkmoveno: row.stkmoveno, typ: row.typ, debtorno: row.debtorno || null },
        lotNumber: lotId ? `PZ/${row.stkmoveno}` : null,
      },
    },
    ctx: ctx.commandContext,
  })
  return false
}

async function applyTransfer(ctx: MovementContext, pair: SortPair): Promise<boolean> {
  const from = ctx.locations.get(pair.out.loccode.toUpperCase())
  const to = ctx.locations.get(pair.in.loccode.toUpperCase())
  const fraction = ctx.fractions.get(pair.in.stockid)
  if (!from || !to) throw new Error(`Nieznana lokalizacja w parze SORT: ${pair.out.loccode} → ${pair.in.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${pair.in.stockid}`)

  const referenceId = legacyUuid('movement', pair.in.stkmoveno)
  const total = Math.abs(pair.in.iloscKg)
  const applied = await appliedQuantity(ctx, referenceId, 'transfer')
  if (applied >= total - EPSILON_KG) {
    return true
  }

  // Masa schodząca z placu leży w partiach z konkretnych przyjęć. Przesuwamy ją
  // partia po partii, żeby w boksie dało się powiedzieć, czyj to odpad - i żeby
  // WMS w ogóle znalazł saldo, z którego ma zdjąć.
  const slices = await sliceByLots(ctx, from.id, fraction.variantId, total - applied)
  for (const [index, slice] of slices.entries()) {
    await ctx.commandBus.execute('wms.inventory.move', {
      input: {
        organizationId: ctx.scope.organizationId,
        tenantId: ctx.scope.tenantId,
        warehouseId: ctx.warehouseId,
        fromLocationId: from.id,
        toLocationId: to.id,
        catalogVariantId: fraction.variantId,
        lotId: slice.lotId,
        quantity: slice.quantity,
        type: 'transfer',
        reason: `Wysortowanie frakcji (SORT ${pair.out.stkmoveno}/${pair.in.stkmoveno})`,
        reasonCode: 'SORT',
        referenceType: 'transfer',
        referenceId,
        performedBy: ctx.performedBy,
        performedAt: parseMoment(pair.in.data),
        metadata: {
          legacy: { stkmoveno: [pair.out.stkmoveno, pair.in.stkmoveno], typ: 'SORT' },
          // Jeden kwit legacy, kilka ruchów magazynowych - bez tego licznika
          // nie widać, że to nie są trzy osobne wysortowania.
          ...(slices.length > 1 ? { czescRuchu: { nr: index + 1, z: slices.length } } : {}),
        },
      },
      ctx: ctx.commandContext,
    })
  }
  return false
}

async function applyIssue(ctx: MovementContext, row: LegacyMovementRow): Promise<boolean> {
  const location = ctx.locations.get(row.loccode.toUpperCase())
  const fraction = ctx.fractions.get(row.stockid)
  if (!location) throw new Error(`Nieznana lokalizacja legacy: ${row.loccode}`)
  if (!fraction) throw new Error(`Nieznana frakcja legacy: ${row.stockid}`)

  const referenceId = legacyUuid('movement', row.stkmoveno)
  const total = Math.abs(row.iloscKg)
  const applied = await appliedQuantity(ctx, referenceId, 'adjust')
  if (applied >= total - EPSILON_KG) {
    return true
  }

  // Wydanie zdejmuje z boksu masę, która trafiła tam z różnych dostaw. Idziemy
  // po partiach od najstarszej - dzięki temu karta przekazania wie, czyj odpad
  // pojechał do odbiorcy, a nie tylko ile go było.
  const slices = await sliceByLots(ctx, location.id, fraction.variantId, total - applied)
  for (const [index, slice] of slices.entries()) {
    await ctx.commandBus.execute('wms.inventory.adjust', {
      input: {
        organizationId: ctx.scope.organizationId,
        tenantId: ctx.scope.tenantId,
        warehouseId: ctx.warehouseId,
        locationId: location.id,
        catalogVariantId: fraction.variantId,
        lotId: slice.lotId,
        delta: -slice.quantity,
        reason: `Wydanie do odbiorcy ${row.debtorno || 'nieznany'} (WZ ${row.stkmoveno})`,
        reasonCode: 'WZ',
        referenceType: 'so',
        referenceId,
        performedBy: ctx.performedBy,
        performedAt: parseMoment(row.data),
        metadata: {
          legacy: {
            stkmoveno: row.stkmoveno,
            typ: row.typ,
            debtorno: row.debtorno || null,
            orderno: row.orderno || null,
          },
          // Identyfikator dokumentu sprzedaży, który to wydanie realizuje.
          // `referenceId` jest zajęty przez klucz idempotencji liczony ze
          // `stkmoveno`, więc powiązanie z zamówieniem idzie metadanymi.
          salesOrderId: salesOrderIdFor(ctx, row) ?? null,
          ...(slices.length > 1 ? { czescRuchu: { nr: index + 1, z: slices.length } } : {}),
        },
      },
      ctx: ctx.commandContext,
    })
  }
  return false
}

/** Zamówienie, które realizuje to wydanie - o ile import objął sprzedaż. */
function salesOrderIdFor(ctx: MovementContext, row: LegacyMovementRow): string | undefined {
  if (!row.orderno) return undefined
  return ctx.salesOrders?.get(row.orderno)
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /idempot|duplicate key|unique/i.test(message)
}

/**
 * Wykonuje partię ruchów. Duplikat jest wynikiem poprawnym: import wolno
 * puścić dwa razy, a księga ma zostać ta sama.
 */
export async function applyMovementBatch(
  ctx: MovementContext,
  rows: LegacyMovementRow[],
  options: { carry?: LegacyMovementRow[]; final?: boolean } = {},
): Promise<{ outcomes: MovementOutcome[]; carry: LegacyMovementRow[] }> {
  const outcomes: MovementOutcome[] = []
  // Para SORT potrafi rozpasc sie na granicy partii: drugi wiersz wpada do
  // nastepnej porcji. Niesparowane wiersze jada dalej zamiast byc bledem.
  const sortRows = [...(options.carry ?? []), ...rows.filter((row) => row.typ === 'SORT')]
  const { pairs, orphans } = pairSortRows(sortRows)

  for (const row of rows.filter((item) => item.typ === 'PZ')) {
    try {
      const replay = await applyReceipt(ctx, row)
      outcomes.push({ externalId: String(row.stkmoveno), action: replay ? 'skip' : 'create', stkmoveno: row.stkmoveno })
    } catch (error) {
      outcomes.push({
        externalId: String(row.stkmoveno),
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: row.stkmoveno,
      })
    }
  }

  for (const pair of pairs) {
    const externalId = `${pair.out.stkmoveno}+${pair.in.stkmoveno}`
    try {
      const replay = await applyTransfer(ctx, pair)
      outcomes.push({ externalId, action: replay ? 'skip' : 'create', stkmoveno: Math.max(pair.out.stkmoveno, pair.in.stkmoveno) })
    } catch (error) {
      outcomes.push({
        externalId,
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: Math.max(pair.out.stkmoveno, pair.in.stkmoveno),
      })
    }
  }

  for (const row of rows.filter((item) => item.typ === 'WZ')) {
    try {
      const replay = await applyIssue(ctx, row)
      outcomes.push({ externalId: String(row.stkmoveno), action: replay ? 'skip' : 'create', stkmoveno: row.stkmoveno })
    } catch (error) {
      outcomes.push({
        externalId: String(row.stkmoveno),
        action: isDuplicate(error) ? 'skip' : 'failed',
        error: isDuplicate(error) ? undefined : String((error as Error)?.message ?? error),
        stkmoveno: row.stkmoveno,
      })
    }
  }

  if (options.final) {
    for (const orphan of orphans) {
      outcomes.push({
        externalId: String(orphan.stkmoveno),
        action: 'failed',
        error: 'Wiersz SORT bez pary - para rozjechała się w eksporcie legacy.',
        stkmoveno: orphan.stkmoveno,
      })
    }
  }

  return {
    outcomes: outcomes.sort((a, b) => a.stkmoveno - b.stkmoveno),
    carry: options.final ? [] : orphans,
  }
}

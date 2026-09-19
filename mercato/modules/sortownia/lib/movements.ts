import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { InventoryBalance, InventoryMovement, type WarehouseLocation } from '@open-mercato/core/modules/wms/data/entities'
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
 *    `transfer` z `locationFrom` i `locationTo` — przesunięcie jest atomowe.
 * 2. `stkmoveno` wchodzi w deterministyczny `referenceId`, z którego WMS buduje
 *    `idempotency_key` pilnowany unikalnym indeksem. Powtórzony import odbija
 *    się od bazy, a nie od naszej pamięci.
 * 3. Masy jadą w kilogramach, bo w takich jednostkach prowadzony jest magazyn;
 *    megagramy są przeliczane na ekranach i w raportach.
 *
 * Do tego dochodzi partia. WMS prowadzi saldo osobno dla każdej partii w danej
 * lokalizacji: przyjęcie ze wskazaną partią ląduje w koszyku tej partii, a
 * przesunięcie i korekta bez `lotId` patrzą wyłącznie na koszyk bez partii —
 * który jest pusty. Legacy nie zna partii, więc `SORT` i `WZ` mówią tylko
 * „ile" i „skąd". Rozstrzygamy to po stronie mostu: masa schodzi z partii
 * leżących w lokalizacji źródłowej w kolejności przyjęcia (FIFO) i jeden wiersz
 * legacy może stać się kilkoma ruchami WMS, po jednym na partię. Wszystkie
 * niosą ten sam `referenceId`, więc po numerze ze starego systemu nadal wraca
 * się do kwitu, a magazyn wie, czyj odpad wyjechał do odbiorcy.
 */

const EPSILON = 0.000001

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
 * ilości — dokładnie to, co w legacy „wiąże" oba wiersze nieformalnie.
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

/**
 * Ile masy z tego wiersza legacy już siedzi w księdze WMS.
 *
 * Klucz idempotencji WMS obejmuje `lotId` i ilość, więc jeden wiersz legacy
 * rozłożony na partie ma w magazynie kilka kluczy — kontrola po kluczu nie
 * powiedziałaby, czy wiersz wszedł w całości. `referenceId` jest naszym
 * własnym, deterministycznym odciskiem `stkmoveno` i nie zmienia się nigdy,
 * dlatego to on rozstrzyga. Zwracamy sumę, a nie flagę: import przerwany w
 * połowie rozkładu na partie dokłada przy powtórce tylko brakującą resztę.
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
    // pamiętać stan sprzed niej.
    { refresh: true } as never,
  )
  let total = 0
  for (const movement of existing as Array<{ quantity: string | number }>) {
    total += Math.abs(Number.parseFloat(String(movement.quantity)))
  }
  return total
}

/** Kawałek masy do zdjęcia z jednej partii (albo z koszyka bez partii). */
export type SourceChunk = { lotId: string | null; quantity: number }

/**
 * Rozkłada masę do zdjęcia z lokalizacji na partie, które w niej leżą.
 *
 * Kolejność jest FIFO po chwili założenia koszyka salda, czyli po kolejności
 * przyjęć — tak schodzi odpad z placu naprawdę: najstarsza pryzma pierwsza.
 * Gdy partie nie pokrywają całej masy, odmawiamy tak samo jak WMS
 * (`insufficient_stock`), zamiast zdejmować część i udawać, że poszło całe.
 */
export async function resolveSourceChunks(
  ctx: MovementContext,
  locationId: string,
  catalogVariantId: string,
  quantity: number,
): Promise<SourceChunk[]> {
  const balances = await ctx.em.find(
    InventoryBalance,
    {
      warehouse: ctx.warehouseId,
      location: locationId,
      catalogVariantId,
      organizationId: ctx.scope.organizationId,
      tenantId: ctx.scope.tenantId,
    } as never,
    { refresh: true, orderBy: { createdAt: 'asc' } } as never,
  )

  const chunks: SourceChunk[] = []
  let remaining = quantity
  for (const balance of balances as Array<{
    lot?: { id: string } | string | null
    quantityOnHand: string | number
    quantityReserved: string | number
    quantityAllocated: string | number
  }>) {
    if (remaining <= EPSILON) break
    const available =
      Number.parseFloat(String(balance.quantityOnHand)) -
      Number.parseFloat(String(balance.quantityReserved)) -
      Number.parseFloat(String(balance.quantityAllocated))
    if (!(available > EPSILON)) continue
    const lotRaw = balance.lot ?? null
    const lotId = typeof lotRaw === 'string' ? lotRaw : lotRaw?.id ?? null
    const take = Math.min(available, remaining)
    chunks.push({ lotId, quantity: Math.round(take * 10000) / 10000 })
    remaining -= take
  }

  if (remaining > EPSILON) {
    throw new Error(
      `insufficient_stock: w lokalizacji brakuje ${remaining.toFixed(2)} kg z ${quantity.toFixed(2)} kg`,
    )
  }
  return chunks
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
  // Przyjęcie wskazuje partię, a `lotId` wchodzi do klucza idempotencji WMS,
  // więc rozstrzygamy po `referenceId` — patrz komentarz przy `appliedQuantity`.
  if ((await appliedQuantity(ctx, referenceId, 'receipt')) > EPSILON) {
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
      quantity: Math.abs(row.iloscKg),
      // Partia niesie dostawcę i datę przyjęcia — bez niej przyjęcie jest
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
  const remaining = total - (await appliedQuantity(ctx, referenceId, 'transfer'))
  if (remaining <= EPSILON) {
    return true
  }

  // Jedna para SORT może zejść z kilku partii: po jednym ruchu na partię,
  // wszystkie z tym samym `referenceId` i tym samym śladem legacy.
  const chunks = await resolveSourceChunks(ctx, from.id, fraction.variantId, remaining)
  for (const chunk of chunks) {
    await ctx.commandBus.execute('wms.inventory.move', {
      input: {
        organizationId: ctx.scope.organizationId,
        tenantId: ctx.scope.tenantId,
        warehouseId: ctx.warehouseId,
        fromLocationId: from.id,
        toLocationId: to.id,
        catalogVariantId: fraction.variantId,
        lotId: chunk.lotId ?? undefined,
        quantity: chunk.quantity,
        type: 'transfer',
        reason: `Wysortowanie frakcji (SORT ${pair.out.stkmoveno}/${pair.in.stkmoveno})`,
        reasonCode: 'SORT',
        referenceType: 'transfer',
        referenceId,
        performedBy: ctx.performedBy,
        performedAt: parseMoment(pair.in.data),
        metadata: {
          legacy: { stkmoveno: [pair.out.stkmoveno, pair.in.stkmoveno], typ: 'SORT' },
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
  const remaining = total - (await appliedQuantity(ctx, referenceId, 'adjust'))
  if (remaining <= EPSILON) {
    return true
  }

  // Wydanie schodzi z partii leżących w boksie — dzięki temu karta przekazania
  // ma odpowiedź, czyj odpad pojechał do odbiorcy.
  const chunks = await resolveSourceChunks(ctx, location.id, fraction.variantId, remaining)
  for (const chunk of chunks) {
    await ctx.commandBus.execute('wms.inventory.adjust', {
      input: {
        organizationId: ctx.scope.organizationId,
        tenantId: ctx.scope.tenantId,
        warehouseId: ctx.warehouseId,
        locationId: location.id,
        catalogVariantId: fraction.variantId,
        lotId: chunk.lotId ?? undefined,
        delta: -chunk.quantity,
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
        },
      },
      ctx: ctx.commandContext,
    })
  }
  return false
}

/** Zamówienie, które realizuje to wydanie — o ile import objął sprzedaż. */
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
        error: 'Wiersz SORT bez pary — para rozjechała się w eksporcie legacy.',
        stkmoveno: orphan.stkmoveno,
      })
    }
  }

  return {
    outcomes: outcomes.sort((a, b) => a.stkmoveno - b.stkmoveno),
    carry: options.final ? [] : orphans,
  }
}

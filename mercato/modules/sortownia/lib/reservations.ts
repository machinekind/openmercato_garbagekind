import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { InventoryReservation } from '@open-mercato/core/modules/wms/data/entities'
import type { FractionIndex } from './fractions'
import type { SalesOrderIndex } from './salesOrders'
import type { LegacyOrderRow } from './legacyFiles'

/**
 * Rezerwacja frakcji pod zamówienie, którego jeszcze nie wydano.
 *
 * Problem jest codzienny i kosztowny: odbiorca zamawia 8 ton szkła z odbiorem
 * za tydzień, a magazynier - nie wiedząc o tym - obiecuje ten sam boks komuś
 * innemu. Stary system nie miał gdzie tego zapisać, bo `locstock` zna tylko
 * jedną liczbę: ile leży. Nie zna różnicy między „leży" a „leży i jest wolne".
 *
 * WMS Open Mercato zna: saldo rozdziela `on_hand` od `available`, a rezerwacje
 * mają własny byt z własnym kluczem idempotencji. Zakładamy je komendą
 * `wms.inventory.reserve` ze źródłem `order`, wskazując zamówienie sprzedaży.
 */

export type ReservationContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  warehouseId: string
  fractions: FractionIndex
  orders: SalesOrderIndex
  /** Numery wydań, które już zaszły - te rezerwacji nie potrzebują. */
  fulfilled: Set<number>
}

export type ReservationOutcome = {
  orderno: number
  action: 'create' | 'skip' | 'failed' | 'insufficient'
  error?: string
}

/**
 * Odmowa rezerwacji z braku towaru to nie awaria importu.
 *
 * WMS odmawia zablokowania masy, której nie ma - i właśnie po to tam jest.
 * Stary system przyjąłby takie zamówienie bez słowa, a brak wyszedłby dopiero
 * przy załadunku, przy kierowcy czekającym pod bramą. Odróżniamy to od błędu
 * technicznego, żeby raport importu nie mieszał jednego z drugim.
 */
function isInsufficientStock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /insufficient_stock|insufficient stock|not enough/i.test(message)
}

export async function loadReservedOrderIds(
  em: EntityManager,
  scope: TenantScope,
): Promise<Set<string>> {
  const rows = await em.find(InventoryReservation, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    sourceType: 'order',
    status: 'active',
  } as never)
  return new Set(
    (rows as Array<{ sourceId?: string | null }>)
      .map((row) => row.sourceId)
      .filter((value): value is string => Boolean(value)),
  )
}

function toDate(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Rezerwuje frakcję dla zamówień, które czekają na realizację.
 *
 * Zamówienie już wydane rezerwacji nie dostaje: towar wyjechał, nie ma czego
 * blokować. Rezerwacja na wydany towar zaniżałaby stan dostępny i blokowała
 * sprzedaż czegoś, czego już nie ma.
 */
export async function applyReservations(
  ctx: ReservationContext,
  rows: LegacyOrderRow[],
): Promise<{ outcomes: ReservationOutcome[] }> {
  const reserved = await loadReservedOrderIds(ctx.em, ctx.scope)
  const outcomes: ReservationOutcome[] = []

  for (const row of rows) {
    if (ctx.fulfilled.has(row.orderno)) continue

    const orderId = ctx.orders.get(row.orderno)
    if (!orderId) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: `zamówienie ${row.orderno} nie jest w Mercato`,
      })
      continue
    }

    if (reserved.has(orderId)) {
      outcomes.push({ orderno: row.orderno, action: 'skip' })
      continue
    }

    const fraction = ctx.fractions.get(row.stockid)
    if (!fraction) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: `frakcja ${row.stockid} nie jest w katalogu`,
      })
      continue
    }

    try {
      await ctx.commandBus.execute('wms.inventory.reserve', {
        input: {
          organizationId: ctx.scope.organizationId,
          tenantId: ctx.scope.tenantId,
          warehouseId: ctx.warehouseId,
          catalogVariantId: fraction.variantId,
          quantity: row.iloscKg,
          sourceType: 'order',
          sourceId: orderId,
          // Rezerwacja wygasa w dniu odbioru: towar niezabrany w terminie musi
          // wrócić do puli dostępnej, inaczej magazyn zamarza na zapas, którego
          // nikt nie odbiera.
          expiresAt: toDate(row.dataWydania),
          metadata: {
            legacy: { orderno: row.orderno, debtorno: row.debtorno, stockid: row.stockid },
            terminOdbioru: row.dataWydania || null,
          },
        },
        ctx: ctx.commandContext,
      })
      reserved.add(orderId)
      outcomes.push({ orderno: row.orderno, action: 'create' })
    } catch (error) {
      outcomes.push({
        orderno: row.orderno,
        action: isInsufficientStock(error) ? 'insufficient' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { outcomes }
}

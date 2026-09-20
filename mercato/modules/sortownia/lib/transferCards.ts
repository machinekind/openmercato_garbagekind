import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SalesOrderLine, SalesShipment } from '@open-mercato/core/modules/sales/data/entities'
import type { SalesOrderIndex } from './salesOrders'
import type { LegacyOrderRow } from './legacyFiles'

/**
 * Karta przekazania odpadu jako wysyłka na zamówieniu sprzedaży.
 *
 * Przekazanie odpadu innemu podmiotowi jest w Polsce ewidencjonowane: dokument
 * towarzyszy transportowi i wymienia masę, kod odpadu, proces, któremu odpad
 * zostanie poddany, oraz numery rejestrowe obu stron. Faktura dokumentuje
 * pieniądze; kartę przekazania dokumentuje *rzecz*, która wyjechała bramą.
 *
 * W Open Mercato dokumentem fizycznego wydania jest wysyłka (`sales.shipments`)
 * i to ona dostaje tę rolę. Nie zakładamy własnej tabeli: `weightValue`
 * z `weightUnit` niosą masę, `shipmentNumber` numer karty, a `trackingNumbers`
 * - numery rejestrowe BDO przekazującego i przejmującego.
 *
 * ZASTRZEŻENIE, którego nie wolno pominąć na scenie: to jest *odpowiednik*
 * karty przekazania odpadu, a nie karta z systemu BDO. Realna KPO powstaje
 * w rejestrze prowadzonym przez administrację i ma numer nadany przez ten
 * rejestr. Tutaj nie ma żadnej integracji z BDO i numery są własne.
 */

export type TransferCardContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  orders: SalesOrderIndex
  /**
   * Numery wydań, które faktycznie zaszły.
   *
   * Karta przekazania dokumentuje przekazanie, które się odbyło. Wystawienie
   * jej dla zamówienia z odbiorem za tydzień byłoby poświadczeniem zdarzenia,
   * do którego jeszcze nie doszło - i w ewidencji odpadów jest to poważny błąd,
   * a nie drobna niedokładność.
   */
  fulfilled: Set<number>
  /** `debtorno` → numer rejestrowy BDO odbiorcy. */
  bdoByDebtor: Map<string, string>
  /** Kod odpadu → kod procesu odzysku (R1, R3, R4, R5). */
  recoveryByStock: Map<string, string>
  /** Numer rejestrowy BDO instalacji, która przekazuje odpad. */
  ownBdo: string
}

export type TransferCardOutcome = {
  orderno: number
  action: 'create' | 'skip' | 'failed'
  error?: string
}

/** Numer karty odtwarzalny z numeru wydania - stąd idempotencja. */
export function cardNumberFor(orderno: number): string {
  return `KPO/${orderno}`
}

export async function loadCardNumbers(em: EntityManager, scope: TenantScope): Promise<Set<string>> {
  const rows = await em.find(SalesShipment, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    shipmentNumber: { $like: 'KPO/%' },
    // Karta wycofana nie blokuje wystawienia nowej: jeżeli wydanie dojdzie
    // do skutku później, ewidencja ma je objąć.
    deletedAt: null,
  } as never)
  return new Set(
    (rows as Array<{ shipmentNumber?: string | null }>)
      .map((row) => row.shipmentNumber)
      .filter((value): value is string => Boolean(value)),
  )
}

function toDate(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** `orderId` → identyfikator pierwszej pozycji zamówienia. */
export async function loadOrderLineByOrder(
  em: EntityManager,
  scope: TenantScope,
): Promise<Map<string, string>> {
  const rows = await em.find(SalesOrderLine, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  } as never)
  const index = new Map<string, string>()
  for (const row of rows as Array<{ id: string; order?: { id: string } | string | null }>) {
    const order = row.order
    const orderId = typeof order === 'string' ? order : order?.id
    if (orderId && !index.has(orderId)) index.set(orderId, row.id)
  }
  return index
}

export async function applyTransferCards(
  ctx: TransferCardContext,
  rows: LegacyOrderRow[],
): Promise<{ outcomes: TransferCardOutcome[] }> {
  const existing = await loadCardNumbers(ctx.em, ctx.scope)
  const lineByOrder = await loadOrderLineByOrder(ctx.em, ctx.scope)
  const outcomes: TransferCardOutcome[] = []

  for (const row of rows) {
    if (!ctx.fulfilled.has(row.orderno)) continue
    const cardNumber = cardNumberFor(row.orderno)
    if (existing.has(cardNumber)) {
      outcomes.push({ orderno: row.orderno, action: 'skip' })
      continue
    }

    const orderId = ctx.orders.get(row.orderno)
    if (!orderId) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: `zamówienie ${row.orderno} nie jest w Mercato`,
      })
      continue
    }

    const kodProcesu = ctx.recoveryByStock.get(row.stockid) ?? ''
    const bdoOdbiorcy = ctx.bdoByDebtor.get(row.debtorno) ?? ''

    try {
      await ctx.commandBus.execute('sales.shipments.create', {
        input: {
          organizationId: ctx.scope.organizationId,
          tenantId: ctx.scope.tenantId,
          orderId,
          shipmentNumber: cardNumber,
          // Masa jest sednem karty przekazania - nie sztuki, nie palety.
          weightValue: row.iloscKg,
          weightUnit: 'kg',
          shippedAt: toDate(row.dataWydania),
          // Oba numery rejestrowe muszą być na karcie: kto przekazuje i komu.
          trackingNumbers: [ctx.ownBdo, bdoOdbiorcy].filter(Boolean),
          notes: [
            `Kod odpadu: ${row.stockid}`,
            kodProcesu ? `Proces odzysku: ${kodProcesu}` : null,
            `Masa: ${row.iloscKg.toFixed(2)} kg`,
            `Przejmujący: ${row.debtorno}${bdoOdbiorcy ? ` (BDO ${bdoOdbiorcy})` : ''}`,
          ]
            .filter(Boolean)
            .join('\n'),
          // Pozycja wysyłki jest wymagana przez platformę, a jej ilość musi być
          // liczbą całkowitą (`quantity.int()`). Wysyłki Open Mercato zakładają
          // sztuki, a odpad waży się z dokładnością do dekagrama.
          //
          // Zaokrąglamy W DÓŁ, nie do najbliższej liczby: platforma odrzuca
          // wysyłkę przekraczającą pozostałą ilość pozycji, więc 3 803,73 kg
          // zaokrąglone do 3 804 nie przechodzi („Cannot ship more than the
          // remaining quantity"). Połowa kart odbijała się właśnie o to.
          //
          // Ilość pozycji jest tu wyłącznie powiązaniem z linią zamówienia.
          // Masą wiążącą - tą, która trafia na kartę przekazania - jest
          // `weightValue` powyżej i ona niesie pełną dokładność.
          items: lineByOrder.has(orderId)
            ? [
                {
                  orderLineId: lineByOrder.get(orderId) as string,
                  quantity: Math.floor(row.iloscKg),
                  metadata: { masaDokladnaKg: row.iloscKg },
                },
              ]
            : undefined,
          metadata: {
            dokument: 'karta przekazania odpadu',
            kodOdpadu: row.stockid,
            kodProcesu: kodProcesu || null,
            bdoPrzekazujacego: ctx.ownBdo || null,
            bdoPrzejmujacego: bdoOdbiorcy || null,
            masaKg: row.iloscKg,
            legacy: { orderno: row.orderno, debtorno: row.debtorno },
          },
        },
        ctx: ctx.commandContext,
      })
      existing.add(cardNumber)
      outcomes.push({ orderno: row.orderno, action: 'create' })
    } catch (error) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { outcomes }
}

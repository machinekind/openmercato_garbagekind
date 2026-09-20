import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SalesInvoice, SalesPayment } from '@open-mercato/core/modules/sales/data/entities'
import type { SalesOrderIndex } from './salesOrders'
import { CURRENCY_FALLBACK } from './salesOrders'
import type { LegacyPaymentRow } from './legacyFiles'

/**
 * Wpłaty odbiorców jako płatności rozliczone na fakturach.
 *
 * Stary system kończył się na fakturze: czy odbiorca zapłacił, wiedziała
 * wyłącznie księgowa i wyłącznie z wyciągu bankowego. Dopóki zapłata nie jest
 * przypięta do dokumentu, nie da się odpowiedzieć na pytanie, które w sortowni
 * pada najczęściej - „ile nam wiszą i od kiedy".
 *
 * Wpłata idzie komendą `sales.payments.create` wraz z alokacją na konkretną
 * fakturę. Sama kwota bez alokacji utworzyłaby płatność wiszącą w powietrzu,
 * a saldo należności nadal byłoby nieznane.
 */

export type PaymentContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  /** `orderno` legacy → identyfikator zamówienia w Mercato. */
  orders: SalesOrderIndex
}

export type PaymentOutcome = {
  transno: number
  action: 'create' | 'skip' | 'failed' | 'mismatch'
  error?: string
}

/** Wpłaty znaczymy numerem legacy - po nim poznajemy, że już weszły. */
export function paymentReferenceFor(transno: number): string {
  return `ZAPL/${transno}`
}

/**
 * Wpłaty, które już weszły, wraz z zaksięgowaną kwotą.
 *
 * Kwota jest tu nie bez powodu. Import jest z założenia dopisujący: raz
 * zaksięgowanej wpłaty nie nadpisujemy, bo dokument księgowy nie zmienia się
 * po cichu. Ale jeżeli po stronie legacy kwota tej samej wpłaty jest już inna,
 * to znaczy, że ktoś ruszył dane u źródła - i milczenie byłoby najgorszą
 * z możliwych odpowiedzi. Zgłaszamy rozjazd zamiast go przemilczeć.
 */
export async function loadPaymentAmounts(
  em: EntityManager,
  scope: TenantScope,
): Promise<Map<string, number>> {
  const rows = await em.find(SalesPayment, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    paymentReference: { $like: 'ZAPL/%' },
  } as never)
  const index = new Map<string, number>()
  for (const row of rows as Array<{ paymentReference?: string | null; amount?: string | number | null }>) {
    if (!row.paymentReference) continue
    index.set(row.paymentReference, Number.parseFloat(String(row.amount ?? '0')))
  }
  return index
}

/** `orderId` → `invoiceId`, bo alokacja płatności celuje w fakturę, nie w zamówienie. */
export async function loadInvoiceByOrder(
  em: EntityManager,
  scope: TenantScope,
): Promise<Map<string, string>> {
  const rows = await em.find(SalesInvoice, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  } as never)
  const index = new Map<string, string>()
  for (const row of rows as Array<{ id: string; order?: { id: string } | string | null }>) {
    const order = row.order
    const orderId = typeof order === 'string' ? order : order?.id
    if (orderId) index.set(orderId, row.id)
  }
  return index
}

function toDate(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export async function applyPayments(
  ctx: PaymentContext,
  rows: LegacyPaymentRow[],
): Promise<{ outcomes: PaymentOutcome[] }> {
  const seen = await loadPaymentAmounts(ctx.em, ctx.scope)
  const invoiceByOrder = await loadInvoiceByOrder(ctx.em, ctx.scope)
  const outcomes: PaymentOutcome[] = []

  for (const row of rows) {
    const reference = paymentReferenceFor(row.transno)
    if (seen.has(reference)) {
      const zaksiegowana = seen.get(reference) ?? 0
      // Tolerancja groszowa: kwoty jadą przez numeric(18,4) i float.
      if (Math.abs(zaksiegowana - row.kwotaBrutto) > 0.01) {
        outcomes.push({
          transno: row.transno,
          action: 'mismatch',
          error: `zaksięgowano ${zaksiegowana.toFixed(2)}, w systemie legacy jest ${row.kwotaBrutto.toFixed(2)}`,
        })
        continue
      }
      outcomes.push({ transno: row.transno, action: 'skip' })
      continue
    }

    const orderId = ctx.orders.get(row.orderno)
    if (!orderId) {
      outcomes.push({
        transno: row.transno,
        action: 'failed',
        error: `zamówienie ${row.orderno} nie jest w Mercato - zaimportuj sprzedaż przed wpłatami`,
      })
      continue
    }

    const invoiceId = invoiceByOrder.get(orderId)

    try {
      await ctx.commandBus.execute('sales.payments.create', {
        input: {
          organizationId: ctx.scope.organizationId,
          tenantId: ctx.scope.tenantId,
          orderId,
          amount: row.kwotaBrutto,
          currencyCode: CURRENCY_FALLBACK,
          paymentReference: reference,
          receivedAt: toDate(row.data),
          metadata: {
            legacy: { transno: row.transno, orderno: row.orderno, debtorno: row.debtorno, typ: row.typ },
          },
          // Alokacja na fakturę to sedno: bez niej powstaje płatność, której
          // żaden dokument nie widzi, a saldo należności zostaje nieznane.
          allocations: invoiceId
            ? [{ invoiceId, amount: row.kwotaBrutto, currencyCode: CURRENCY_FALLBACK }]
            : [{ orderId, amount: row.kwotaBrutto, currencyCode: CURRENCY_FALLBACK }],
        },
        ctx: ctx.commandContext,
      })
      seen.set(reference, row.kwotaBrutto)
      outcomes.push({ transno: row.transno, action: 'create' })
    } catch (error) {
      outcomes.push({
        transno: row.transno,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { outcomes }
}

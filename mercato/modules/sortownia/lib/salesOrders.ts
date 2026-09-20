import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SalesInvoice, SalesOrder } from '@open-mercato/core/modules/sales/data/entities'
import type { CustomerIndex } from './customers'
import type { FractionIndex } from './fractions'
import type { LegacyOrderRow } from './legacyFiles'

/**
 * Wydania odpadu jako dokumenty sprzedaży Open Mercato.
 *
 * W starym systemie wydanie to jeden wiersz `salesorders` i ujemna liczba
 * w księdze ruchów. Nie ma z tego ani faktury, ani należności, ani śladu, kto
 * i po jakiej cenie odebrał frakcję - księgowa dopisuje to ręcznie w Excelu.
 *
 * Po stronie Mercato to samo wydanie staje się zamówieniem sprzedaży z pozycją
 * wskazującą wariant katalogowy frakcji, ilością w kilogramach i ceną za
 * kilogram. Z zamówienia platforma sama wystawia fakturę i sama nadaje jej
 * numer (`salesDocumentNumberGenerator`).
 *
 * Idempotencja: `orderNumber` ma w bazie unikalny indeks w zakresie
 * organizacji i tenanta, więc powtórzony import odbija się od bazy, a nie od
 * naszej pamięci - dokładnie tak, jak przy ruchach magazynowych.
 */

export type SalesOrderContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  customers: CustomerIndex
  fractions: FractionIndex
  /** Czy po zamówieniu wystawiać od razu fakturę. */
  issueInvoices: boolean
}

export type SalesOrderOutcome = {
  orderno: number
  action: 'create' | 'skip' | 'failed'
  orderId?: string
  invoiced?: boolean
  error?: string
}

/** `orderno` → identyfikator zamówienia w Mercato; używa go mapowanie ruchów WZ. */
export type SalesOrderIndex = Map<number, string>

/**
 * Stawka VAT dla sprzedaży frakcji.
 *
 * Uproszczenie świadome i warte nazwania: obrót niektórymi odpadami
 * i surowcami wtórnymi bywa w Polsce objęty odwrotnym obciążeniem albo inną
 * stawką niż podstawowa. Demo liczy 23% jednolicie i nie udaje, że rozstrzyga
 * kwalifikację podatkową - od tego jest księgowość, której tu z założenia nie ma.
 */
export const VAT_RATE = 23

export const CURRENCY_FALLBACK = 'PLN'

/** Numer dokumentu odtwarzalny z numeru legacy - stąd idempotencja. */
export function orderNumberFor(orderno: number): string {
  return `WZ/${orderno}`
}

export async function loadSalesOrderIndex(
  em: EntityManager,
  scope: TenantScope,
): Promise<SalesOrderIndex> {
  const rows = await em.find(SalesOrder, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    externalReference: { $ne: null },
  } as never)
  const index: SalesOrderIndex = new Map()
  for (const row of rows as Array<{ id: string; externalReference?: string | null }>) {
    const orderno = Number.parseInt(row.externalReference ?? '', 10)
    if (Number.isFinite(orderno)) index.set(orderno, row.id)
  }
  return index
}

function toDate(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export async function applySalesOrders(
  ctx: SalesOrderContext,
  rows: LegacyOrderRow[],
): Promise<{ index: SalesOrderIndex; outcomes: SalesOrderOutcome[] }> {
  const index = await loadSalesOrderIndex(ctx.em, ctx.scope)
  const outcomes: SalesOrderOutcome[] = []

  for (const row of rows) {
    if (index.has(row.orderno)) {
      outcomes.push({ orderno: row.orderno, action: 'skip', orderId: index.get(row.orderno) })
      continue
    }

    const fraction = ctx.fractions.get(row.stockid)
    if (!fraction) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: `frakcja ${row.stockid} nie jest w katalogu - zaimportuj frakcje przed zamówieniami`,
      })
      continue
    }

    const customerEntityId = ctx.customers.get(row.debtorno)
    if (!customerEntityId) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: `kontrahent ${row.debtorno} nie jest w CRM - zaimportuj kontrahentów przed zamówieniami`,
      })
      continue
    }

    const netAmount = Number((row.iloscKg * row.cenaKg).toFixed(2))

    try {
      const created = (await ctx.commandBus.execute('sales.orders.create', {
        input: {
          organizationId: ctx.scope.organizationId,
          tenantId: ctx.scope.tenantId,
          orderNumber: orderNumberFor(row.orderno),
          externalReference: String(row.orderno),
          customerEntityId,
          currencyCode: CURRENCY_FALLBACK,
          placedAt: toDate(row.dataZamowienia),
          expectedDeliveryAt: toDate(row.dataWydania),
          comments: `Wydanie frakcji ${row.stockid} do odbiorcy ${row.debtorno} (zamówienie ${row.orderno} z systemu legacy)`,
          metadata: {
            legacy: {
              orderno: row.orderno,
              debtorno: row.debtorno,
              stockid: row.stockid,
              iloscKg: row.iloscKg,
              cenaKg: row.cenaKg,
            },
          },
          lines: [
            {
              productId: fraction.productId,
              productVariantId: fraction.variantId,
              name: `Frakcja ${row.stockid}`,
              // Magazyn prowadzi frakcję w kilogramach i dokument sprzedaży
              // musi mówić tą samą jednostką - inaczej rozjazd wyjdzie dopiero
              // przy uzgadnianiu faktury ze stanem.
              quantity: row.iloscKg,
              quantityUnit: 'kg',
              currencyCode: CURRENCY_FALLBACK,
              unitPriceNet: row.cenaKg,
              taxRate: VAT_RATE,
              priceMode: 'net',
            },
          ],
        },
        ctx: ctx.commandContext,
        // Koperta `{ result, logEntry }` - jak przy komendach CRM.
      })) as { result?: { orderId?: string } } | undefined

      const orderId = created?.result?.orderId
      if (!orderId) {
        outcomes.push({ orderno: row.orderno, action: 'failed', error: 'komenda nie zwróciła identyfikatora zamówienia' })
        continue
      }
      index.set(row.orderno, orderId)

      let invoiced = false
      if (ctx.issueInvoices) {
        // Kwoty przepisujemy z zamówienia, którego totale policzył
        // `salesCalculationService` platformy. Powód jest zasadniczy:
        // `sales.invoices.create` - w przeciwieństwie do `sales.orders.create`
        // - nie woła silnika wyliczeń, więc pozycje faktury zapisują się
        // z zerowymi kwotami mimo poprawnej ilości, ceny i stawki VAT.
        // Sprawdzone na żywej bazie: 40 faktur, każda na 0,00 zł.
        //
        // Własne mnożenie ilości przez cenę byłoby drugą, równoległą logiką
        // podatkową obok platformowej - a dwie takie logiki prędzej czy później
        // się rozjadą. Dlatego czytamy wynik tamtej.
        const placed = await ctx.em.findOne(SalesOrder, { id: orderId } as never)
        const totals = placed as unknown as {
          grandTotalNetAmount?: string | null
          grandTotalGrossAmount?: string | null
        } | null
        const netTotal = Number.parseFloat(totals?.grandTotalNetAmount ?? '0')
        const grossTotal = Number.parseFloat(totals?.grandTotalGrossAmount ?? '0')
        // Numer faktury nadaje platforma: własne numerowanie dokumentów
        // sprzedaży to dokładnie ta rzecz, której nie chcemy pisać sami.
        const invoice = (await ctx.commandBus.execute('sales.invoices.create', {
          input: {
            organizationId: ctx.scope.organizationId,
            tenantId: ctx.scope.tenantId,
            orderId,
            currencyCode: CURRENCY_FALLBACK,
            issueDate: toDate(row.dataWydania),
            metadata: { legacy: { orderno: row.orderno, netAmount } },
            grandTotalNetAmount: netTotal,
            grandTotalGrossAmount: grossTotal,
            lines: [
              {
                name: `Frakcja ${row.stockid}`,
                sku: row.stockid,
                quantity: row.iloscKg,
                quantityUnit: 'kg',
                currencyCode: CURRENCY_FALLBACK,
                unitPriceNet: row.cenaKg,
                taxRate: VAT_RATE,
                totalNetAmount: netTotal,
                taxAmount: Number((grossTotal - netTotal).toFixed(4)),
                totalGrossAmount: grossTotal,
              },
            ],
          },
          ctx: ctx.commandContext,
        })) as { result?: { invoiceId?: string } } | undefined

        // Obejście błędu w `sales.invoices.create`: komenda przyjmuje `orderId`,
        // sprawdza, że zamówienie istnieje w tym samym zakresie - a potem
        // zapisuje encję przez `em.create(SalesInvoice, { orderId })`. Encja ma
        // jednak tylko relację `order` (`@ManyToOne`, kolumna `order_id`), więc
        // MikroORM po cichu odrzuca nieznaną właściwość i faktura ląduje
        // w bazie z pustym `order_id`. Zweryfikowane na żywej bazie: 40 faktur,
        // 0 powiązanych.
        //
        // Dowiązujemy ją tu przez `nativeUpdate` na relacji, czyli właściwym
        // API ORM-a, a nie surowym SQL-em. Gdy błąd zostanie naprawiony po
        // stronie platformy, ten zapis stanie się nadmiarowy, ale nieszkodliwy.
        const invoiceId = invoice?.result?.invoiceId
        if (invoiceId) {
          await ctx.em.nativeUpdate(SalesInvoice, { id: invoiceId }, { order: orderId } as never)
        }
        invoiced = true
      }

      outcomes.push({ orderno: row.orderno, action: 'create', orderId, invoiced })
    } catch (error) {
      outcomes.push({
        orderno: row.orderno,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { index, outcomes }
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'

/**
 * Dane pulpitu sortowni.
 *
 * Wszystko liczymy z encji WMS, a nie z osobnej tabeli raportowej: pulpit ma
 * pokazywać ten sam stan, który widzi magazyn, a nie jego kopię sprzed godziny.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sortownia.view'] },
}

type LocationRow = {
  code: string
  type: string
  capacityKg: number | null
  quantityKg: number | null
  utilisation: number | null
  legacyName: string | null
}

type FractionRow = {
  sku: string
  name: string
  quantityKg: number
  reorderPointKg: number | null
  belowReorderPoint: boolean
}

type MovementRow = {
  id: string
  type: string
  performedAt: string
  quantityKg: number
  fractionSku: string | null
  fractionName: string | null
  fromCode: string | null
  toCode: string | null
  reason: string | null
  legacyMoveNo: number | string | null
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

// `getAuthFromRequest`, nie wariant „z ciastek": poza przeglądarką po pulpit
// sięgają też skrypty i testy integracyjne, które niosą sesję w nagłówku
// `Authorization: Bearer`. Wariant ciastkowy odprawiłby je z 401.
export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return unauthorized()

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    // Super-admin oglądający „wszystkie organizacje" nie ma wybranego zakresu;
    // 400 zamiast 401, żeby klient nie wpadł w pętlę odświeżania sesji.
    return new Response(JSON.stringify({ error: 'organization_scope_required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const scope = { organizationId, tenantId: auth.tenantId as string }

  const locations = await em.getConnection().execute<Array<{
    code: string
    type: string
    capacity_weight: string | null
    metadata: Record<string, unknown> | null
    quantity: string | null
  }>>(
    `select l.code,
            l.type,
            l.capacity_weight,
            l.metadata,
            coalesce(sum(b.quantity_on_hand), 0) as quantity
       from wms_warehouse_locations l
       left join wms_inventory_balances b
              on b.location_id = l.id
             and b.deleted_at is null
      where l.organization_id = ?
        and l.tenant_id = ?
        and l.deleted_at is null
      group by l.id, l.code, l.type, l.capacity_weight, l.metadata
      order by l.code`,
    [scope.organizationId, scope.tenantId],
  )

  const locationRows: LocationRow[] = locations.map((row) => {
    const capacityKg = row.capacity_weight === null ? null : Number.parseFloat(row.capacity_weight)
    const quantityKg = row.quantity === null ? 0 : Number.parseFloat(row.quantity)
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    return {
      code: row.code,
      type: row.type,
      capacityKg,
      quantityKg,
      utilisation: capacityKg && capacityKg > 0 ? Math.round((quantityKg / capacityKg) * 1000) / 10 : null,
      legacyName: typeof metadata.legacyName === 'string' ? metadata.legacyName : null,
    }
  })

  const fractions = await em.getConnection().execute<Array<{
    sku: string
    name: string | null
    quantity: string | null
    reorder_point: string | null
  }>>(
    `select v.sku,
            coalesce(v.name, p.title) as name,
            coalesce(sum(b.quantity_on_hand), 0) as quantity,
            max(pr.reorder_point) as reorder_point
       from catalog_product_variants v
       join catalog_products p on p.id = v.product_id
       left join wms_inventory_balances b
              on b.catalog_variant_id = v.id
             and b.deleted_at is null
       left join wms_product_inventory_profiles pr
              on pr.catalog_variant_id = v.id
             and pr.deleted_at is null
      where v.organization_id = ?
        and v.tenant_id = ?
        and v.deleted_at is null
        and v.sku is not null
        -- Katalog Mercato trzyma też produkty spoza sortowni (demo, usługi).
        -- Frakcją jest tylko pozycja, którą przyniósł import z systemu legacy.
        and exists (
          select 1
            from wms_product_inventory_profiles pl
           where pl.catalog_variant_id = v.id
             and pl.deleted_at is null
             and pl.metadata->>'legacyStockid' is not null
        )
      group by v.sku, v.name, p.title
      order by quantity desc`,
    [scope.organizationId, scope.tenantId],
  )

  const fractionRows: FractionRow[] = fractions.map((row) => {
    const quantityKg = row.quantity === null ? 0 : Number.parseFloat(row.quantity)
    const reorderPointKg = row.reorder_point === null ? null : Number.parseFloat(row.reorder_point)
    return {
      sku: row.sku,
      name: row.name ?? row.sku,
      quantityKg,
      reorderPointKg,
      belowReorderPoint: reorderPointKg !== null && quantityKg < reorderPointKg,
    }
  })

  const movements = await em.getConnection().execute<Array<{
    id: string
    type: string
    performed_at: string
    quantity: string
    reason: string | null
    metadata: Record<string, unknown> | string | null
    sku: string | null
    variant_name: string | null
    from_code: string | null
    to_code: string | null
  }>>(
    // Jeden wiersz legacy może być kilkoma ruchami WMS (po jednym na partię);
    // operator ma widzieć kwit, nie rozkład na partie — zwijamy po `reference_id`.
    `select min(m.id::text) as id,
            m.type,
            m.performed_at,
            sum(m.quantity) as quantity,
            m.reason,
            min(m.metadata::text) as metadata,
            v.sku,
            v.name as variant_name,
            lf.code as from_code,
            lt.code as to_code
       from wms_inventory_movements m
       left join catalog_product_variants v on v.id = m.catalog_variant_id
       left join wms_warehouse_locations lf on lf.id = m.location_from_id
       left join wms_warehouse_locations lt on lt.id = m.location_to_id
      where m.organization_id = ?
        and m.tenant_id = ?
        and m.deleted_at is null
      group by m.reference_id, m.type, m.performed_at, m.reason, v.sku, v.name, lf.code, lt.code
      order by m.performed_at desc, min(m.created_at) desc
      limit 20`,
    [scope.organizationId, scope.tenantId],
  )

  const movementRows: MovementRow[] = movements.map((row) => {
    const rawMetadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
    const metadata = (rawMetadata ?? {}) as { legacy?: { stkmoveno?: number | number[] } }
    const legacy = metadata.legacy?.stkmoveno
    return {
      id: row.id,
      type: row.type,
      performedAt: new Date(row.performed_at).toISOString(),
      quantityKg: Number.parseFloat(row.quantity),
      fractionSku: row.sku,
      fractionName: row.variant_name,
      fromCode: row.from_code,
      toCode: row.to_code,
      reason: row.reason,
      legacyMoveNo: Array.isArray(legacy) ? legacy.join(' + ') : (legacy ?? null),
    }
  })

  const flowByFraction = await em.getConnection().execute<Array<{
    sku: string
    received: string
    sorted: string
    issued: string
  }>>(
    `select v.sku,
            coalesce(sum(case when m.type = 'receipt' then m.quantity else 0 end), 0) as received,
            coalesce(sum(case when m.type = 'transfer' then m.quantity else 0 end), 0) as sorted,
            coalesce(sum(case when m.type = 'adjust' then abs(m.quantity) else 0 end), 0) as issued
       from wms_inventory_movements m
       join catalog_product_variants v on v.id = m.catalog_variant_id
      where m.organization_id = ?
        and m.tenant_id = ?
        and m.deleted_at is null
        and m.performed_at >= now() - interval '30 days'
      group by v.sku
      order by received desc`,
    [scope.organizationId, scope.tenantId],
  )

  const [flow] = await em.getConnection().execute<Array<{
    receipts: string
    issues: string
    transfers: string
    total: string
    last_performed_at: string | null
  }>>(
    `select coalesce(sum(case when type = 'receipt' then quantity else 0 end), 0) as receipts,
            coalesce(sum(case when type = 'adjust' then abs(quantity) else 0 end), 0) as issues,
            coalesce(sum(case when type = 'transfer' then quantity else 0 end), 0) as transfers,
            count(distinct (reference_id, type)) as total,
            max(performed_at) as last_performed_at
       from wms_inventory_movements
      where organization_id = ?
        and tenant_id = ?
        and deleted_at is null
        and performed_at >= now() - interval '30 days'`,
    [scope.organizationId, scope.tenantId],
  )

  // Sprzedaż frakcji: to, czego stary system nie umiał powiedzieć w ogóle.
  // Liczymy z dokumentów sprzedaży, a nie z ruchów magazynowych — pieniądze
  // i kilogramy mają osobne źródła prawdy i tak ma zostać.
  const [sales] = await em.getConnection().execute<Array<{
    orders: string
    net: string
    gross: string
    invoices: string
  }>>(
    `select count(distinct o.id) as orders,
            coalesce(sum(o.grand_total_net_amount), 0) as net,
            coalesce(sum(o.grand_total_gross_amount), 0) as gross,
            count(distinct i.id) as invoices
       from sales_orders o
       left join sales_invoices i
              on i.order_id = o.id
             and i.organization_id = o.organization_id
             and i.tenant_id = o.tenant_id
             and i.deleted_at is null
      where o.organization_id = ?
        and o.tenant_id = ?
        and o.deleted_at is null
        and o.external_reference is not null`,
    [scope.organizationId, scope.tenantId],
  )

  // Kwoty agregujemy SQL-em, ale nazwy kontrahentów MUSZĄ przyjść przez ORM.
  // `customer_entities.display_name` jest szyfrowane w spoczynku, więc surowy
  // odczyt oddaje kryptogram w rodzaju `BZhh3D8l...:v1` i ląduje on wprost na
  // ekranie operatora. Sprawdzone na żywej bazie — dlatego agregat idzie po
  // identyfikatorze, a nazwy dociągamy `findWithDecryption`.
  const buyerTotals = await em.getConnection().execute<Array<{
    customer_entity_id: string
    net: string
    orders: string
  }>>(
    `select o.customer_entity_id,
            coalesce(sum(o.grand_total_net_amount), 0) as net,
            count(*) as orders
       from sales_orders o
      where o.organization_id = ?
        and o.tenant_id = ?
        and o.deleted_at is null
        and o.external_reference is not null
        and o.customer_entity_id is not null
      group by o.customer_entity_id
      order by sum(o.grand_total_net_amount) desc
      limit 5`,
    [scope.organizationId, scope.tenantId],
  )

  // Należności: ile wystawiono, ile wpłynęło, ile wisi i od jak dawna.
  // Wpłaty liczymy z alokacji, a nie z samych płatności — płatność bez
  // alokacji nie zmniejsza salda żadnego dokumentu.
  const [receivables] = await em.getConnection().execute<Array<{
    billed: string
    paid: string
    overdue_docs: string
    oldest_days: string | null
  }>>(
    `with faktury as (
       select i.id,
              i.issue_date,
              coalesce(sum(il.total_gross_amount), 0) as brutto
         from sales_invoices i
         join sales_orders o on o.id = i.order_id
         left join sales_invoice_lines il on il.invoice_id = i.id
        where i.organization_id = ?
          and i.tenant_id = ?
          and i.deleted_at is null
          and o.external_reference is not null
        group by i.id, i.issue_date
     ),
     wplaty as (
       select a.invoice_id, coalesce(sum(a.amount), 0) as kwota
         from sales_payment_allocations a
         join faktury f on f.id = a.invoice_id
        group by a.invoice_id
     )
     select coalesce(sum(f.brutto), 0) as billed,
            coalesce(sum(w.kwota), 0) as paid,
            count(*) filter (where coalesce(w.kwota, 0) < f.brutto) as overdue_docs,
            max(extract(day from now() - f.issue_date)) filter (
              where coalesce(w.kwota, 0) < f.brutto
            ) as oldest_days
       from faktury f
       left join wplaty w on w.invoice_id = f.id`,
    [scope.organizationId, scope.tenantId],
  )

  const buyerIds = buyerTotals.map((row) => row.customer_entity_id)
  const buyerEntities = buyerIds.length
    ? await findWithDecryption(
        em,
        CustomerEntity,
        { id: { $in: buyerIds } } as never,
        {},
        { tenantId: scope.tenantId, organizationId: scope.organizationId },
      )
    : []
  const buyerNames = new Map(
    (buyerEntities as Array<{ id: string; displayName?: string | null }>).map((row) => [
      row.id,
      row.displayName ?? '',
    ]),
  )

  // Identyfikowalność: skąd wzięła się masa na placu. Partie zakładane są
  // przy przyjęciu i niosą dostawcę w metadanych, więc pytanie „czyj to odpad"
  // ma odpowiedź w magazynie, a nie w pamięci brygadzisty.
  const suppliers = await em.getConnection().execute<Array<{
    dostawca: string
    lots: string
    masa: string
  }>>(
    `select coalesce(l.metadata->>'dostawca', 'nieznany') as dostawca,
            count(*) as lots,
            coalesce(sum((l.metadata->>'masaPrzyjeciaKg')::numeric), 0) as masa
       from wms_inventory_lots l
      where l.organization_id = ?
        and l.tenant_id = ?
        and l.deleted_at is null
        and l.lot_number like 'PZ/%'
      group by 1
      order by sum((l.metadata->>'masaPrzyjeciaKg')::numeric) desc
      limit 6`,
    [scope.organizationId, scope.tenantId],
  )

  // Ewidencja przekazań: ile kart wystawiono, na jaką masę i czy któraś
  // nie ma kompletu danych wymaganych przy przekazaniu odpadu.
  const [cards] = await em.getConnection().execute<Array<{
    total: string
    masa: string
    bez_procesu: string
    bez_bdo: string
  }>>(
    `select count(*) as total,
            coalesce(sum(s.weight_value), 0) as masa,
            count(*) filter (where s.metadata->>'kodProcesu' is null) as bez_procesu,
            count(*) filter (where s.metadata->>'bdoPrzejmujacego' is null) as bez_bdo
       from sales_shipments s
      where s.organization_id = ?
        and s.tenant_id = ?
        and s.deleted_at is null
        and s.shipment_number like 'KPO/%'`,
    [scope.organizationId, scope.tenantId],
  )

  // Rezerwacje: ile masy jest obiecane odbiorcom i nie wolno jej sprzedać
  // drugi raz. Stary system znał tylko jedną liczbę — ile leży.
  const [reservations] = await em.getConnection().execute<Array<{
    total: string
    masa: string
  }>>(
    `select count(*) as total,
            coalesce(sum(r.quantity), 0) as masa
       from wms_inventory_reservations r
      where r.organization_id = ?
        and r.tenant_id = ?
        and r.status = 'active'
        and r.source_type = 'order'`,
    [scope.organizationId, scope.tenantId],
  )

  // Bilans masy i sprawność sortowania — liczby, którymi zakład rozlicza się
  // ze sprawozdawczości i po których poznaje, czy sortownia w ogóle sortuje.
  const [balance] = await em.getConnection().execute<Array<{
    przyjete: string
    wysortowane: string
    wydane: string
  }>>(
    `select coalesce(sum(case when type = 'receipt' then quantity else 0 end), 0) as przyjete,
            coalesce(sum(case when type = 'transfer' then quantity else 0 end), 0) as wysortowane,
            coalesce(sum(case when type = 'adjust' then abs(quantity) else 0 end), 0) as wydane
       from wms_inventory_movements
      where organization_id = ?
        and tenant_id = ?
        and deleted_at is null`,
    [scope.organizationId, scope.tenantId],
  )

  const perFractionRevenue = await em.getConnection().execute<Array<{
    sku: string
    netto: string
    masa: string
  }>>(
    `select l.name as sku,
            coalesce(sum(l.total_net_amount), 0) as netto,
            coalesce(sum(l.quantity), 0) as masa
       from sales_order_lines l
       join sales_orders o on o.id = l.order_id
      where o.organization_id = ?
        and o.tenant_id = ?
        and o.deleted_at is null
        and o.external_reference is not null
      group by l.name
      order by sum(l.total_net_amount) desc`,
    [scope.organizationId, scope.tenantId],
  )

  const yardKg = locationRows
    .filter((row) => row.type === 'staging')
    .reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)
  const binsKg = locationRows
    .filter((row) => row.type !== 'staging')
    .reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: {
        yardKg,
        binsKg,
        receipts30dKg: Number.parseFloat(flow?.receipts ?? '0'),
        issues30dKg: Number.parseFloat(flow?.issues ?? '0'),
        sorted30dKg: Number.parseFloat(flow?.transfers ?? '0'),
        movements30d: Number.parseInt(flow?.total ?? '0', 10),
        lastMovementAt: flow?.last_performed_at ? new Date(flow.last_performed_at).toISOString() : null,
      },
      locations: locationRows,
      fractions: fractionRows,
      flow: flowByFraction.map((row) => ({
        sku: row.sku,
        receivedKg: Number.parseFloat(row.received),
        sortedKg: Number.parseFloat(row.sorted),
        issuedKg: Number.parseFloat(row.issued),
      })),
      movements: movementRows,
      bilans: (() => {
        const przyjete = Number.parseFloat(balance?.przyjete ?? '0')
        const wysortowane = Number.parseFloat(balance?.wysortowane ?? '0')
        const wydane = Number.parseFloat(balance?.wydane ?? '0')
        const naStanie = locationRows.reduce((sum, row) => sum + (row.quantityKg ?? 0), 0)
        return {
          receivedKg: przyjete,
          sortedKg: wysortowane,
          issuedKg: wydane,
          onHandKg: naStanie,
          // Bilans domyka się, gdy przyjęte minus wydane równa się temu, co leży.
          // Sortowanie jest przesunięciem wewnętrznym i masy nie zmienia, więc
          // do bilansu nie wchodzi. Różnica oznacza ubytek albo błąd ewidencji.
          differenceKg: Number((przyjete - wydane - naStanie).toFixed(2)),
          // Sprawność: ile z przyjętego udało się wysortować na frakcje.
          sortingRate: przyjete > 0 ? Number(((wysortowane / przyjete) * 100).toFixed(1)) : null,
          perFraction: perFractionRevenue.map((row) => ({
            sku: row.sku,
            netPln: Number.parseFloat(row.netto),
            soldKg: Number.parseFloat(row.masa),
            pricePerKg:
              Number.parseFloat(row.masa) > 0
                ? Number((Number.parseFloat(row.netto) / Number.parseFloat(row.masa)).toFixed(4))
                : null,
          })),
        }
      })(),
      rezerwacje: {
        count: Number.parseInt(reservations?.total ?? '0', 10),
        reservedKg: Number.parseFloat(reservations?.masa ?? '0'),
      },
      ewidencja: {
        cards: Number.parseInt(cards?.total ?? '0', 10),
        massKg: Number.parseFloat(cards?.masa ?? '0'),
        withoutProcess: Number.parseInt(cards?.bez_procesu ?? '0', 10),
        withoutBdo: Number.parseInt(cards?.bez_bdo ?? '0', 10),
      },
      traceability: {
        lots: suppliers.reduce((sum, row) => sum + Number.parseInt(row.lots, 10), 0),
        suppliers: suppliers.map((row) => ({
          dostawca: row.dostawca,
          lots: Number.parseInt(row.lots, 10),
          receivedKg: Number.parseFloat(row.masa),
        })),
      },
      sales: {
        orders: Number.parseInt(sales?.orders ?? '0', 10),
        invoices: Number.parseInt(sales?.invoices ?? '0', 10),
        netPln: Number.parseFloat(sales?.net ?? '0'),
        grossPln: Number.parseFloat(sales?.gross ?? '0'),
        billedPln: Number.parseFloat(receivables?.billed ?? '0'),
        paidPln: Number.parseFloat(receivables?.paid ?? '0'),
        outstandingPln:
          Number.parseFloat(receivables?.billed ?? '0') - Number.parseFloat(receivables?.paid ?? '0'),
        unpaidDocs: Number.parseInt(receivables?.overdue_docs ?? '0', 10),
        oldestUnpaidDays: receivables?.oldest_days ? Number.parseInt(receivables.oldest_days, 10) : null,
        topBuyers: buyerTotals.map((row) => ({
          nazwa: buyerNames.get(row.customer_entity_id) || 'Kontrahent bez nazwy',
          netPln: Number.parseFloat(row.net),
          orders: Number.parseInt(row.orders, 10),
        })),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

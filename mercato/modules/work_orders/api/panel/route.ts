import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Panel przedsiębiorstwa.
 *
 * To jest jedyny ekran w całym projekcie, który odpowiada na pytanie zadawane
 * przez kierownika zakładu, a nie przez inżyniera: **ile hala wyprodukowała,
 * na czyją rzecz, i ile z tego robot zgubił po drodze**. Trzy pierwsze rzeczy
 * są w module `sortownia`, czwarta w module `episodes`, a nigdzie dotąd nie
 * stały w jednym wierszu.
 *
 * Zapytanie jest jedno i zbiera wszystko na raz. Wariant z osobnym zapytaniem
 * per zlecenie byłby czytelniejszy i przy stu zleceniach dziennie zmieniłby
 * pulpit w klepsydrę.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['work_orders.view'] },
}

type OrderRow = {
  id: string
  orderNumber: string
  /** Potrzebne rzutowi hali do zsumowania wyniku per cela - po identyfikatorze,
   *  nie po nazwie: nazwy się powtarzają i zmieniają. */
  cellId: string | null
  sku: string
  cell: string | null
  policy: string | null
  salesOrderNumber: string | null
  status: string
  targetKg: number
  producedKg: number
  progressRatio: number | null
  batches: number
  openBatch: string | null
  /** Rozjazd zbiorczy w kg; `null` znaczy brak masy nominalnej, nie zero. */
  driftKg: number | null
  driftRatio: number | null
  /** Partie, w których waga pokazała mniej, niż robot zgłosił. */
  overclaimBatches: number
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) {
    return new Response(JSON.stringify({ error: 'organization_scope_required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const tenantId = auth.tenantId as string

  const rows = await em.getConnection().execute<Array<{
    id: string
    order_number: string
    sku: string
    status: string
    target_grams: string
    cell_id: string | null
    cell: string | null
    policy: string | null
    sales_order_number: string | null
    produced_grams: string | null
    batch_count: string
    open_batch: string | null
    expected_grams: string | null
    drift_grams: string | null
    overclaim_batches: string
  }>>(
    `select o.id, o.order_number, o.sku, o.status, o.target_grams,
            o.cell_id, c.name as cell,
            case when p.policy_key is null then null
                 else p.policy_key || ' v' || v.version end as policy,
            so.order_number as sales_order_number,
            b.produced_grams, b.batch_count, b.open_batch,
            r.expected_grams, r.drift_grams, r.overclaim_batches
       from work_orders_orders o
       left join fleet_cells c on c.id = o.cell_id
       left join policy_registry_policy_versions v on v.id = o.policy_version_id
       left join policy_registry_policies p on p.id = v.policy_id
       left join sales_orders so on so.id = o.sales_order_id
       left join lateral (
            select sum(wb.weighed_grams) filter (where wb.status = 'closed') as produced_grams,
                   count(*) filter (where wb.status = 'closed') as batch_count,
                   max(wb.container_code) filter (where wb.status = 'filling') as open_batch
              from work_orders_batches wb
             where wb.work_order_id = o.id
       ) b on true
       left join lateral (
            -- Tylko NAJNOWSZE uzgodnienie każdej partii: ponowne ważenie
            -- dopisuje wpis, a sumowanie wszystkich liczyłoby tę samą partię
            -- tyle razy, ile razy stanęła na wadze.
            select sum(x.expected_grams) as expected_grams,
                   sum(x.drift_grams) as drift_grams,
                   count(*) filter (where x.verdict = 'overclaim') as overclaim_batches
              from (
                   select distinct on (rec.batch_id) rec.expected_grams, rec.drift_grams, rec.verdict
                     from work_orders_reconciliations rec
                     join work_orders_batches wb2 on wb2.id = rec.batch_id
                    where wb2.work_order_id = o.id
                    order by rec.batch_id, rec.computed_at desc
              ) x
       ) r on true
      where o.tenant_id = ?
        and o.deleted_at is null
      order by o.status, o.opened_at desc
      limit 200`,
    [tenantId],
  )

  const orders: OrderRow[] = rows.map((row) => {
    const targetGrams = Number(row.target_grams ?? 0)
    const producedGrams = Number(row.produced_grams ?? 0)
    const expectedGrams = row.expected_grams === null ? null : Number(row.expected_grams)
    const driftGrams = row.drift_grams === null ? null : Number(row.drift_grams)

    return {
      id: row.id,
      orderNumber: row.order_number,
      sku: row.sku,
      cellId: row.cell_id,
      cell: row.cell,
      policy: row.policy,
      salesOrderNumber: row.sales_order_number,
      status: row.status,
      targetKg: targetGrams / 1000,
      producedKg: producedGrams / 1000,
      progressRatio: targetGrams > 0 ? producedGrams / targetGrams : null,
      batches: Number(row.batch_count ?? 0),
      openBatch: row.open_batch,
      driftKg: driftGrams === null ? null : driftGrams / 1000,
      driftRatio: expectedGrams && expectedGrams > 0 && driftGrams !== null ? driftGrams / expectedGrams : null,
      overclaimBatches: Number(row.overclaim_batches ?? 0),
    }
  })

  const zOdniesieniem = orders.filter((o) => o.driftKg !== null)
  const produced = orders.reduce((acc, o) => acc + o.producedKg, 0)
  const drift = zOdniesieniem.reduce((acc, o) => acc + (o.driftKg ?? 0), 0)

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: {
        ordersOpen: orders.filter((o) => o.status === 'open').length,
        producedKg: Number(produced.toFixed(3)),
        // Rozjazd sumowany w kilogramach, nie uśredniany w procentach:
        // średnia z procentów zrównuje partię dwutonową z pięciokilogramową.
        driftKg: Number(drift.toFixed(3)),
        ordersWithoutReference: orders.length - zOdniesieniem.length,
        overclaimBatches: orders.reduce((acc, o) => acc + o.overclaimBatches, 0),
      },
      orders,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

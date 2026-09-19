import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { contamination, triangulate, type Suspect } from '../../lib/triangulate'

/**
 * Panel wzroku maszynowego.
 *
 * Ekran łączy trzech świadków jednej partii roboczej: kamerę nad pojemnikiem,
 * deklarację robota i wagę. Zwraca **podejrzanego**, a nie sam rozjazd — bo
 * rozjazd widać już w panelu przedsiębiorstwa, a nowa informacja zaczyna się
 * dopiero tam, gdzie da się powiedzieć, po której stronie leży błąd.
 *
 * Czego ten endpoint **nie** zwraca: adresów nagrań. Materiał wideo jest za
 * osobnym uprawnieniem (`vision.clips.view`), bo podgląd zliczeń i podgląd
 * nagrania pracownika to dwie różne rzeczy.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['vision.view'] },
}

type BatchRow = {
  containerCode: string
  sku: string
  /** Po identyfikatorze, bo rzut hali łączy po celi, a nazwy się powtarzają. */
  cellId: string | null
  cell: string | null
  visionCount: number | null
  claimedCount: number
  massImpliedCount: number | null
  weighedKg: number
  suspect: Suspect
  reason: string
  contaminationRatio: number | null
  windows: number
  countingMode: string | null
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

  /**
   * Materiał oznaczony, ale nadal istniejący — właściwa liczba zgodności.
   * Liczba oznaczeń sama w sobie nie mówi nic: z punktu widzenia przepisu
   * nagranie, którego nikt nie skasował, wciąż tam jest.
   */
  const retencja = await em.getConnection().execute<Array<{ nieusuniete: string; po_terminie: string }>>(
    `select count(*) filter (where marked_for_deletion_at is not null and deletion_confirmed_at is null) as nieusuniete,
            count(*) filter (where delete_after <= now() and marked_for_deletion_at is null and legal_hold_reference is null) as po_terminie
       from vision_clips where tenant_id = ?`,
    [tenantId],
  )

  const cameras = await em.getConnection().execute<Array<{
    code: string
    view_role: string
    purpose: string
    retention_days: number
    people_in_view: boolean
    notified: string | null
    marked: string | null
    cell: string | null
  }>>(
    `select c.code, c.view_role, c.purpose, c.retention_days, c.people_in_view,
            c.workforce_notified_at as notified, c.area_marked_at as marked, fc.name as cell
       from vision_cameras c
       left join fleet_cells fc on fc.id = c.cell_id
      where c.tenant_id = ? and c.deleted_at is null
      order by c.code`,
    [tenantId],
  )

  /**
   * Partie zamknięte wraz ze zliczeniami wizji z ich okna.
   *
   * Zliczenia sumowane w podzapytaniu bocznym, nie osobnym zapytaniem per
   * partia: przy kilkuset partiach różnica jest między pulpitem a klepsydrą.
   */
  const batches = await em.getConnection().execute<Array<{
    container_code: string
    sku: string
    cell_id: string | null
    cell: string | null
    claimed_pieces: number | null
    weighed_grams: string | null
    nominal_piece_grams: number | null
    counts: Record<string, number> | null
    windows: string
    counting_modes: string[] | null
  }>>(
    `select b.container_code, o.sku, o.cell_id, fc.name as cell,
            b.claimed_pieces, b.weighed_grams, o.nominal_piece_grams,
            v.counts, v.windows, v.counting_modes
       from work_orders_batches b
       join work_orders_orders o on o.id = b.work_order_id
       left join fleet_cells fc on fc.id = o.cell_id
       left join lateral (
            select jsonb_object_agg(k.klasa, k.suma) as counts,
                   count(distinct w.id) as windows,
                   array_agg(distinct w.counting_mode) as counting_modes
              from vision_detection_windows w
              join vision_cameras c on c.id = w.camera_id and c.view_role = 'bin_outfeed'
              cross join lateral (
                   select key as klasa, sum(value::int) as suma
                     from jsonb_each(w.counts) group by key
              ) k
             where w.tenant_id = b.tenant_id
               and w.cell_id = o.cell_id
               and w.started_at >= b.opened_at
               and w.started_at < coalesce(b.closed_at, now())
       ) v on true
      where b.tenant_id = ? and b.status = 'closed'
      order by b.closed_at desc nulls last
      limit 100`,
    [tenantId],
  )

  const rows: BatchRow[] = batches.map((row) => {
    const counts = row.counts ?? {}
    const klasa = 'pet'
    const windows = Number(row.windows ?? 0)
    const tryby = (row.counting_modes ?? []).filter(Boolean)

    // Mieszanka trybów zliczania nie sumuje się do jednej liczby, więc wizja
    // nie występuje wtedy jako świadek — zamiast podawać liczbę bez znaczenia.
    const mieszane = tryby.length > 1
    const visionCount = windows > 0 && !mieszane ? Number(counts[klasa] ?? 0) : null

    const weighedGrams = Number(row.weighed_grams ?? 0)
    const wynik = triangulate({
      depositedCount: visionCount,
      claimedCount: Number(row.claimed_pieces ?? 0),
      weighedGrams,
      nominalPieceGrams: row.nominal_piece_grams,
    })
    const sklad = contamination(counts, klasa)

    return {
      containerCode: row.container_code,
      sku: row.sku,
      cellId: row.cell_id,
      cell: row.cell,
      visionCount,
      claimedCount: Number(row.claimed_pieces ?? 0),
      massImpliedCount: wynik.massImpliedCount,
      weighedKg: weighedGrams / 1000,
      suspect: wynik.suspect,
      reason: wynik.reason,
      contaminationRatio: sklad.ratio,
      windows,
      countingMode: mieszane ? 'mixed' : (tryby[0] ?? null),
    }
  })

  const bySuspect = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.suspect] = (acc[row.suspect] ?? 0) + 1
    return acc
  }, {})

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: {
        cameras: cameras.length,
        // Kamery formalnie niedomknięte: w kadrze bywają ludzie, a brakuje
        // informacji dla załogi albo oznaczenia obszaru (art. 22² § 7 i § 9 KP).
        camerasWithGaps: cameras.filter((c) => c.people_in_view && (!c.notified || !c.marked)).length,
        batches: rows.length,
        withThirdWitness: rows.filter((r) => r.visionCount !== null).length,
        suspected: rows.filter((r) => r.suspect !== 'none' && r.suspect !== 'no_reference').length,
        clipsOverdueUnmarked: Number(retencja?.[0]?.po_terminie ?? 0),
        clipsMarkedNotDeleted: Number(retencja?.[0]?.nieusuniete ?? 0),
      },
      bySuspect,
      cameras: cameras.map((c) => ({
        code: c.code,
        viewRole: c.view_role,
        purpose: c.purpose,
        retentionDays: c.retention_days,
        peopleInView: c.people_in_view,
        cell: c.cell,
        formalGaps: [
          c.people_in_view && !c.notified ? 'brak informacji dla załogi (§ 7)' : null,
          c.people_in_view && !c.marked ? 'brak oznaczenia obszaru (§ 9)' : null,
        ].filter(Boolean),
      })),
      batches: rows,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

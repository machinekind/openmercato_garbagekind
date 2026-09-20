import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { cadence, cadenceBy, verifyAgainstLedger, type EpisodeEntry } from '../../lib/cadence'

/**
 * Raport kadencji autonomii: epizody między interwencjami, per polityka i per cela.
 *
 * Raport liczony jest **w czystej funkcji na wczytanej księdze**, a nie
 * agregatem w SQL-u. To jest decyzja, nie lenistwo: reguła wyliczona w SQL-u
 * raportu byłaby nieweryfikowalna inaczej niż drugim SQL-em, a ta ma być
 * sprawdzalna testem jednostkowym w każdym wariancie. Cena - wczytanie księgi
 * do pamięci - jest przy flocie manipulatorów akceptowalna; przy milionie
 * epizodów na dobę pierwszym krokiem będzie okno czasowe, a nie przepisanie
 * reguły na agregat.
 *
 * `getAuthFromRequest`, nie wariant ciastkowy - skrypty dowodowe niosą sesję
 * w nagłówku.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['episodes.view'] },
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type Row = EpisodeEntry & {
  robotId: string
  serialNumber: string
  policyLabel: string | null
  cellLabel: string | null
  startedAt: string
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) return json({ error: 'organization_scope_required' }, 400)

  const tenantId = auth.tenantId as string
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  /**
   * Porządek: po robocie, potem po numerze kolejnym epizodu.
   *
   * Seria bez interwencji jest własnością czasu w obrębie jednej maszyny.
   * Sortowanie globalnie po czasie sklejałoby serie dwóch robotów w jedną
   * i dawało kadencję, której żadna maszyna nigdy nie osiągnęła.
   */
  const rows = await em.getConnection().execute<Array<{
    id: string
    robot_id: string
    serial_number: string
    sequence: number
    outcome: string
    intervention_count: number
    started_at: string
    policy_key: string | null
    policy_version: number | null
    cell_name: string | null
  }>>(
    `select e.id, e.robot_id, r.serial_number, e.sequence, e.outcome, e.intervention_count,
            e.started_at, p.policy_key, v.version as policy_version, c.name as cell_name
       from episodes_episodes e
       join fleet_robots r on r.id = e.robot_id
       left join policy_registry_policy_versions v on v.id = e.policy_version_id
       left join policy_registry_policies p on p.id = v.policy_id
       left join fleet_cells c on c.id = e.cell_id
      where e.tenant_id = ?
      order by e.robot_id, e.sequence`,
    [tenantId],
  )

  const entries: Row[] = rows.map((row) => ({
    id: row.id,
    sequence: Number(row.sequence),
    outcome: row.outcome as EpisodeEntry['outcome'],
    interventionCount: Number(row.intervention_count),
    robotId: row.robot_id,
    serialNumber: row.serial_number,
    policyLabel: row.policy_key ? `${row.policy_key} v${row.policy_version}` : null,
    cellLabel: row.cell_name,
    startedAt: new Date(row.started_at).toISOString(),
  }))

  // Księga jako druga, niezależna strona rachunku - liczona przez bazę, nie przez nas.
  const ledgerRows = await em.getConnection().execute<Array<{ episodes: string; interventions: string }>>(
    `select (select count(*) from episodes_episodes where tenant_id = ?) as episodes,
            (select count(*) from episodes_interventions where tenant_id = ?) as interventions`,
    [tenantId, tenantId],
  )
  const ledger = {
    episodes: Number(ledgerRows[0]?.episodes ?? 0),
    interventions: Number(ledgerRows[0]?.interventions ?? 0),
  }

  const overall = cadence(entries)
  const check = verifyAgainstLedger(overall, ledger)

  const byPolicy = cadenceBy(entries, (entry) => entry.policyLabel)
  const byCell = cadenceBy(entries, (entry) => entry.cellLabel)
  const byRobot = cadenceBy(entries, (entry) => entry.serialNumber)

  const interventionsByKind = await em.getConnection().execute<Array<{ kind: string; n: string }>>(
    `select kind, count(*) as n from episodes_interventions where tenant_id = ? group by kind order by kind`,
    [tenantId],
  )
  const interventionsByStage = await em.getConnection().execute<Array<{ stage: string | null; n: string }>>(
    `select stage, count(*) as n from episodes_interventions where tenant_id = ? group by stage order by 2 desc`,
    [tenantId],
  )

  const asObject = (map: Map<string, ReturnType<typeof cadence>>) =>
    Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))

  return json(
    {
      generatedAt: new Date().toISOString(),
      ledger,
      /**
       * Wynik kontroli spójności jedzie **w odpowiedzi**, a nie tylko w logu.
       *
       * Raport, który rozjechał się z księgą, ma o tym powiedzieć na ekranie.
       * Cichy rozjazd zostaje zauważony po kwartale i wtedy nie wiadomo już,
       * której liczbie wierzyć w żadnym z minionych tygodni.
       */
      consistency: check,
      overall,
      byPolicy: asObject(byPolicy),
      byCell: asObject(byCell),
      byRobot: asObject(byRobot),
      interventionsByKind: Object.fromEntries(interventionsByKind.map((r) => [r.kind, Number(r.n)])),
      interventionsByStage: Object.fromEntries(
        interventionsByStage.map((r) => [r.stage ?? '(bez etapu)', Number(r.n)]),
      ),
    },
    200,
  )
}

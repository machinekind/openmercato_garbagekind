import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { evaluateClearance, type RiskClass, type SafetyCaseStatus } from '../../lib/clearance'

/**
 * Macierz dopuszczeń: wersja polityki × klasa celi.
 *
 * Ekran ma odpowiedzieć regulatorowi i operatorowi na to samo pytanie zadane
 * z dwóch stron: **co wolno uruchomić i gdzie**, a tam gdzie nie wolno -
 * dlaczego dokładnie. Lista uzasadnień bez kolumny „czego brakuje" jest
 * rejestrem dokumentów, a nie narzędziem.
 *
 * Macierz liczona jest po parach (wersja, klasa celi) występujących
 * w rejestrze floty, a nie po wszystkich możliwych kombinacjach: klasa celi,
 * której nikt nie ma, nie wymaga dopuszczenia.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['safety.view'] },
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) return json({ error: 'organization_scope_required' }, 400)

  const tenantId = auth.tenantId as string
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const cellClasses = await em.getConnection().execute<Array<{ cell_class: string; risk_class: string }>>(
    `select distinct cell_class, risk_class from fleet_cells where tenant_id = ? and deleted_at is null`,
    [tenantId],
  )

  const versions = await em.getConnection().execute<Array<{
    id: string
    label: string
    status: string
    embodiment_spec_digest: string
  }>>(
    `select v.id, p.policy_key || ' v' || v.version as label, v.status, v.embodiment_spec_digest
       from policy_registry_policy_versions v
       join policy_registry_policies p on p.id = v.policy_id
      where v.tenant_id = ? and v.status <> 'deprecated'
      order by p.policy_key, v.version`,
    [tenantId],
  )

  const suites = await em.getConnection().execute<Array<{
    suite_key: string
    name: string
    required_for: string[]
  }>>(`select suite_key, name, required_for from safety_eval_suites where tenant_id = ? order by suite_key`, [tenantId])

  const runs = await em.getConnection().execute<Array<{
    suite_key: string
    policy_version_id: string
    result: string
    ran_at: string
    embodiment_spec_digest: string | null
  }>>(
    `select suite_key, policy_version_id, result, ran_at, embodiment_spec_digest
       from safety_eval_runs where tenant_id = ?`,
    [tenantId],
  )

  const cases = await em.getConnection().execute<Array<{
    cell_class: string
    status: string
    policy_version_id: string
    valid_until: string | null
    declared_as_safety_function: boolean
    safety_layer: string | null
  }>>(
    `select cell_class, status, policy_version_id, valid_until, declared_as_safety_function, safety_layer
       from safety_cases where tenant_id = ?`,
    [tenantId],
  )

  const requirements = suites.map((s) => ({
    suiteKey: s.suite_key,
    requiredFor: (s.required_for ?? []) as RiskClass[],
  }))

  const matrix: Array<Record<string, unknown>> = []
  for (const version of versions) {
    for (const cell of cellClasses) {
      const verdict = evaluateClearance({
        policyVersionId: version.id,
        policyEmbodimentSpecDigest: version.embodiment_spec_digest,
        cellClass: cell.cell_class,
        riskClass: cell.risk_class as RiskClass,
        requirements,
        runs: runs
          .filter((r) => r.policy_version_id === version.id)
          .map((r) => ({
            suiteKey: r.suite_key,
            policyVersionId: r.policy_version_id,
            result: r.result as 'pass' | 'fail' | 'error',
            ranAt: new Date(r.ran_at),
            embodimentSpecDigest: r.embodiment_spec_digest,
          })),
        safetyCases: cases
          .filter((c) => c.policy_version_id === version.id)
          .map((c) => ({
            cellClass: c.cell_class,
            status: c.status as SafetyCaseStatus,
            policyVersionId: c.policy_version_id,
            validUntil: c.valid_until ? new Date(c.valid_until) : null,
            declaredAsSafetyFunction: Boolean(c.declared_as_safety_function),
          })),
      })

      matrix.push({
        policyVersionId: version.id,
        policy: version.label,
        policyStatus: version.status,
        cellClass: cell.cell_class,
        riskClass: cell.risk_class,
        cleared: verdict.cleared,
        reasons: verdict.reasons,
        missingSuites: verdict.missingSuites,
        failedSuites: verdict.failedSuites,
      })
    }
  }

  const incidents = await em.getConnection().execute<Array<{
    id: string
    harm: string
    priority: string
    halt_deployment: boolean
    description: string
    occurred_at: string
    safety_layer_engaged: boolean
    policy_implicated: boolean
  }>>(
    `select id, harm, priority, halt_deployment, description, occurred_at,
            safety_layer_engaged, policy_implicated
       from safety_incidents where tenant_id = ? order by occurred_at desc limit 20`,
    [tenantId],
  )

  return json(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        versions: versions.length,
        cellClasses: cellClasses.length,
        cleared: matrix.filter((m) => m.cleared).length,
        blocked: matrix.filter((m) => !m.cleared).length,
        // Uzasadnienia deklarujące politykę jako funkcję bezpieczeństwa.
        // W zdrowym systemie zero - i to jest najważniejsza liczba na ekranie.
        // Liczone są wyłącznie te NIE wycofane: wycofana deklaracja nie blokuje
        // już dopuszczenia, więc alarm świecący po niej świeciłby na zawsze,
        // a alarm, który świeci zawsze, przestaje być alarmem.
        declaredAsSafetyFunction: cases.filter(
          (c) => c.declared_as_safety_function && c.status !== 'withdrawn',
        ).length,
        openIncidents: incidents.filter((i) => i.halt_deployment).length,
      },
      suites: suites.map((s) => ({ suiteKey: s.suite_key, name: s.name, requiredFor: s.required_for })),
      matrix,
      incidents: incidents.map((i) => ({
        id: i.id,
        harm: i.harm,
        priority: i.priority,
        haltDeployment: i.halt_deployment,
        description: i.description,
        occurredAt: new Date(i.occurred_at).toISOString(),
        safetyLayerEngaged: i.safety_layer_engaged,
        policyImplicated: i.policy_implicated,
      })),
    },
    200,
  )
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Dane rejestru polityk dla pulpitu.
 *
 * `getAuthFromRequest`, nie wariant ciastkowy: po ten endpoint sięgają skrypty
 * dowodowe i testy integracyjne niosące sesję w nagłówku `Authorization`.
 *
 * Ekran pokazuje jedną rzecz, której nie widać w żadnym repozytorium modeli:
 * **czy wersja ma pod sobą sprzęt, na którym wolno ją uruchomić**. Lista wag
 * bez tej kolumny jest katalogiem plików.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['policy_registry.view'] },
}

type VersionRow = {
  id: string
  version: number
  contentDigest: string
  status: string
  statusReason: string | null
  embodiment: string | null
  embodimentRevision: number | null
  /** Czy odcisk kontraktu zapisany przy wersji wciąż zgadza się z rewizją w rejestrze floty. */
  embodimentDrift: boolean
  artifactRoles: string[]
  observationDim: number | null
  actionDim: number | null
  observationSpec: Record<string, unknown> | null
  actionSpec: Record<string, unknown> | null
  controlFrequencyHz: number | null
  leaseExpiryBehavior: string | null
  createdAt: string
}

type PolicyRow = {
  id: string
  policyKey: string
  name: string
  embodimentKey: string
  taskKey: string
  learningMethod: string
  versions: VersionRow[]
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

  try {
    return await czytajRejestr(em, tenantId)
  } catch (error) {
    /**
     * Bez tego bloku wyjatek konczyl sie pustym 500 bez naglowka typu, a
     * przegladarka pokazywala „Unexpected end of JSON input" - komunikat,
     * ktory mowi o parserze, a nie o przyczynie. Najczestsza przyczyna jest
     * prozaiczna: modul doinstalowany bez `db migrate`, wiec zapytanie siega
     * po kolumne, ktorej jeszcze nie ma.
     */
    console.error('[policy_registry] GET /api/policy_registry/policies', error)
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}

async function czytajRejestr(em: EntityManager, tenantId: string): Promise<Response> {
  const policies = await em.getConnection().execute<Array<{
    id: string
    policy_key: string
    name: string
    embodiment_key: string
    task_key: string
    learning_method: string
  }>>(
    `select id, policy_key, name, embodiment_key, task_key, learning_method
       from policy_registry_policies
      where tenant_id = ? and deleted_at is null
      order by policy_key`,
    [tenantId],
  )

  /**
   * Wersje jednym zapytaniem, z lewym złączeniem do rewizji embodimentu.
   *
   * `left join`, nie `join`: rewizja usunięta miękko w rejestrze floty nie może
   * sprawić, że wersja polityki **zniknie** z rejestru. Zniknięcie wpisu jest
   * najgorszą możliwą reakcją na niespójność - lepiej pokazać wiersz z pustym
   * embodimentem i rozjazdem oznaczonym wprost.
   */
  const versions = await em.getConnection().execute<Array<{
    id: string
    policy_id: string
    version: number
    content_digest: string
    status: string
    status_reason: string | null
    embodiment_spec_digest: string
    created_at: string
    embodiment_key: string | null
    revision: number | null
    spec_digest: string | null
    observation_dim: number | null
    action_dim: number | null
    observation_spec: Record<string, unknown> | null
    action_spec: Record<string, unknown> | null
    control_frequency_hz: number | null
    lease_expiry_behavior: string | null
  }>>(
    `select v.id, v.policy_id, v.version, v.content_digest, v.status, v.status_reason,
            v.embodiment_spec_digest, v.created_at, v.observation_dim, v.action_dim,
            v.observation_spec, v.action_spec, v.control_frequency_hz, v.lease_expiry_behavior,
            e.embodiment_key, e.revision, e.spec_digest
       from policy_registry_policy_versions v
       left join fleet_embodiment_revisions e on e.id = v.embodiment_revision_id
      where v.tenant_id = ?
      order by v.policy_id, v.version desc`,
    [tenantId],
  )

  const artifacts = await em.getConnection().execute<Array<{
    policy_version_id: string
    role: string
  }>>(
    `select policy_version_id, role from policy_registry_artifacts where tenant_id = ? order by role`,
    [tenantId],
  )

  const rolesByVersion = new Map<string, string[]>()
  for (const row of artifacts) {
    const list = rolesByVersion.get(row.policy_version_id) ?? []
    list.push(row.role)
    rolesByVersion.set(row.policy_version_id, list)
  }

  const versionsByPolicy = new Map<string, VersionRow[]>()
  for (const row of versions) {
    const list = versionsByPolicy.get(row.policy_id) ?? []
    list.push({
      id: row.id,
      version: Number(row.version),
      contentDigest: row.content_digest,
      status: row.status,
      statusReason: row.status_reason,
      embodiment: row.embodiment_key ? `${row.embodiment_key}@r${row.revision}` : null,
      embodimentRevision: row.revision == null ? null : Number(row.revision),
      embodimentDrift: row.spec_digest != null && row.spec_digest !== row.embodiment_spec_digest,
      artifactRoles: rolesByVersion.get(row.id) ?? [],
      observationDim: row.observation_dim == null ? null : Number(row.observation_dim),
      actionDim: row.action_dim == null ? null : Number(row.action_dim),
      observationSpec: row.observation_spec,
      actionSpec: row.action_spec,
      controlFrequencyHz: row.control_frequency_hz == null ? null : Number(row.control_frequency_hz),
      leaseExpiryBehavior: row.lease_expiry_behavior,
      createdAt: new Date(row.created_at).toISOString(),
    })
    versionsByPolicy.set(row.policy_id, list)
  }

  const rows: PolicyRow[] = policies.map((policy) => ({
    id: policy.id,
    policyKey: policy.policy_key,
    name: policy.name,
    embodimentKey: policy.embodiment_key,
    taskKey: policy.task_key,
    learningMethod: policy.learning_method,
    versions: versionsByPolicy.get(policy.id) ?? [],
  }))

  const allVersions = rows.flatMap((p) => p.versions)

  return json(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        policies: rows.length,
        versions: allVersions.length,
        released: allVersions.filter((v) => v.status === 'released').length,
        deprecated: allVersions.filter((v) => v.status === 'deprecated').length,
        // Liczba, która w zdrowym systemie jest zerem i dlatego warto ją pokazywać.
        embodimentDrift: allVersions.filter((v) => v.embodimentDrift).length,
        orphanedEmbodiment: allVersions.filter((v) => v.embodiment === null).length,
      },
      policies: rows,
    },
    200,
  )
}

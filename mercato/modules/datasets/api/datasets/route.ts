import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { verifyLoop } from '../../lib/lineage'

/**
 * Pochodzenie - obie strony pętli w jednej odpowiedzi.
 *
 * Endpoint odpowiada na dwa pytania zadane z przeciwnych stron:
 * **z czego powstał ten zbiór** i **która polityka się na nim uczyła**.
 * To są dwa odwzorowania, nie jedno, więc obie listy braków liczone są
 * osobno: polityka bez wskazanego zbioru i zbiór bez epizodów to dwie różne
 * dziury i obie trzeba umieć nazwać.
 *
 * `getAuthFromRequest`, nie wariant ciastkowy.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['datasets.view'] },
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

  const versions = await em.getConnection().execute<Array<{
    id: string
    dataset_id: string
    dataset_key: string
    dataset_name: string
    task_key: string
    embodiment_key: string
    version: number
    content_digest: string
    episode_count: number
    demo_count: number
    correction_count: number
    failure_count: number
    holdout_count: number
    warnings: Array<{ code: string; message: string }> | null
    built_at: string
    export_uri: string | null
  }>>(
    `select v.id, v.dataset_id, d.dataset_key, d.name as dataset_name, d.task_key, d.embodiment_key,
            v.version, v.content_digest, v.episode_count, v.demo_count, v.correction_count,
            v.failure_count, v.holdout_count, v.warnings, v.built_at, v.export_uri
       from datasets_versions v
       join datasets_datasets d on d.id = v.dataset_id
      where v.tenant_id = ?
      order by d.dataset_key, v.version desc`,
    [tenantId],
  )

  const runs = await em.getConnection().execute<Array<{
    id: string
    dataset_version_id: string
    policy_version_id: string | null
    run_ref: string
    status: string
    framework: string | null
    policy_label: string | null
    started_at: string
    finished_at: string | null
  }>>(
    `select t.id, t.dataset_version_id, t.policy_version_id, t.run_ref, t.status, t.framework,
            case when p.policy_key is null then null else p.policy_key || ' v' || pv.version end as policy_label,
            t.started_at, t.finished_at
       from datasets_training_runs t
       left join policy_registry_policy_versions pv on pv.id = t.policy_version_id
       left join policy_registry_policies p on p.id = pv.policy_id
      where t.tenant_id = ?
      order by t.started_at desc`,
    [tenantId],
  )

  /**
   * Strona odwrotna pętli: dla wersji polityki - z jakich epizodów powstała.
   *
   * Liczba **rozróżnialnych** epizodów, bo jedna polityka bywa dostrajana
   * kolejno na dwóch zbiorach, które częściowo się pokrywają. Suma liczności
   * zbiorów zawyżałaby odpowiedź na pytanie „ile danych widziała ta polityka".
   */
  const byPolicy = await em.getConnection().execute<Array<{
    policy_version_id: string
    policy_label: string
    dataset_versions: string
    source_episodes: string
  }>>(
    `select t.policy_version_id,
            p.policy_key || ' v' || pv.version as policy_label,
            count(distinct t.dataset_version_id) as dataset_versions,
            count(distinct m.episode_id) as source_episodes
       from datasets_training_runs t
       join policy_registry_policy_versions pv on pv.id = t.policy_version_id
       join policy_registry_policies p on p.id = pv.policy_id
       join datasets_members m on m.dataset_version_id = t.dataset_version_id
      where t.tenant_id = ? and t.policy_version_id is not null
      group by 1, 2 order by 2`,
    [tenantId],
  )

  const allPolicyVersions = await em.getConnection().execute<Array<{ id: string; label: string }>>(
    `select v.id, p.policy_key || ' v' || v.version as label
       from policy_registry_policy_versions v
       join policy_registry_policies p on p.id = v.policy_id
      where v.tenant_id = ?`,
    [tenantId],
  )

  const loop = verifyLoop({
    policyVersionIds: allPolicyVersions.map((v) => v.id),
    datasetVersions: versions.map((v) => ({ id: v.id, memberCount: Number(v.episode_count) })),
    links: runs
      .filter((r) => r.policy_version_id)
      .map((r) => ({
        datasetVersionId: r.dataset_version_id,
        datasetKey: '',
        datasetVersion: 0,
        policyVersionId: r.policy_version_id as string,
        trainingRunRef: r.run_ref,
      })),
  })

  const labelById = new Map(allPolicyVersions.map((v) => [v.id, v.label]))
  const runsByVersion = new Map<string, unknown[]>()
  for (const run of runs) {
    const list = runsByVersion.get(run.dataset_version_id) ?? []
    list.push({
      id: run.id,
      runRef: run.run_ref,
      status: run.status,
      framework: run.framework,
      policy: run.policy_label,
      startedAt: new Date(run.started_at).toISOString(),
      finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    })
    runsByVersion.set(run.dataset_version_id, list)
  }

  return json(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        datasetVersions: versions.length,
        trainingRuns: runs.length,
        /**
         * Pętla jest zamknięta, gdy każda polityka ma skąd pochodzić i każdy
         * zbiór ma z czego się składać. Zbiór, na którym jeszcze nic się nie
         * uczyło, jej nie łamie - i dlatego jest liczony osobno.
         */
        loopClosed: loop.closed,
        policiesWithoutDataset: loop.policiesWithoutDataset.length,
        datasetsWithoutEpisodes: loop.datasetsWithoutEpisodes.length,
        datasetsWithoutPolicy: loop.datasetsWithoutPolicy.length,
      },
      /** Polityki, o których nie wiadomo, skąd się wzięły - nazwane, nie policzone. */
      orphanPolicies: loop.policiesWithoutDataset.map((id) => labelById.get(id) ?? id).sort(),
      versions: versions.map((v) => ({
        id: v.id,
        datasetKey: v.dataset_key,
        datasetName: v.dataset_name,
        taskKey: v.task_key,
        embodimentKey: v.embodiment_key,
        version: Number(v.version),
        contentDigest: v.content_digest,
        episodeCount: Number(v.episode_count),
        composition: {
          demo: Number(v.demo_count),
          correction: Number(v.correction_count),
          failure: Number(v.failure_count),
          holdout: Number(v.holdout_count),
        },
        warnings: v.warnings ?? [],
        exportUri: v.export_uri,
        builtAt: new Date(v.built_at).toISOString(),
        trainingRuns: runsByVersion.get(v.id) ?? [],
      })),
      byPolicy: byPolicy.map((row) => ({
        policyVersionId: row.policy_version_id,
        policy: row.policy_label,
        datasetVersions: Number(row.dataset_versions),
        sourceEpisodes: Number(row.source_episodes),
      })),
    },
    200,
  )
}

import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { ensureDictionaryEntry } from '@open-mercato/core/modules/customers/commands/shared'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'

/**
 * Firmy i szanse sprzedaży jako jedna prawda, a nie dwie listy obok siebie.
 *
 * Etap cyklu życia firmy mówi, na czym stoimy z kontrahentem; szansa
 * sprzedaży mówi to samo z perspektywy lejka. Trzymane osobno rozjeżdżają się
 * po pierwszym tygodniu. Tu jest reguła, która je spina:
 *
 *   klient (customer)   ⇄ szansa wygrana (win)
 *   potencjalny/lead    ⇄ szansa otwarta (open)
 *   dostawca (supplier) → nie ma go w lejku sprzedaży w ogóle
 *
 * Kierunek firma → szansa: każda firma z etapem ma mieć szansę o pasującym
 * statusie; dostawca nie może mieć żadnej. Kierunek szansa → firma: firma bez
 * etapu, ale ze szansą, dostaje etap z jej statusu; a wygrana szansa robi z
 * potencjalnego klienta — bo wygrana to fakt, nie opinia.
 */

/** Etap „dostawca" nie istnieje w słowniku Open Mercato — zakładamy go sami. */
export const SUPPLIER_STAGE = 'supplier'

/** Znacznik szans zakładanych przez synchronizację, żeby odróżnić je od ręcznych. */
export const CRM_SYNC_SOURCE = 'sortownia-crm-sync'

export type DealStatus = 'win' | 'open'

export type CrmCompany = {
  id: string
  displayName: string
  lifecycleStage: string | null
}

export type CrmDeal = {
  id: string
  status: string
  source: string | null
  companyIds: string[]
}

export type CrmAction =
  | { kind: 'set-stage'; companyId: string; stage: string; reason: string }
  | { kind: 'create-deal'; companyId: string; status: DealStatus; title: string }
  | { kind: 'update-deal'; dealId: string; status: DealStatus }
  | { kind: 'unlink-company'; dealId: string; companyId: string; companyIds: string[] }
  | { kind: 'delete-deal'; dealId: string; reason: string }

/** Etap cyklu życia firmy → status szansy, jaką firma ma mieć. `null` = żadnej. */
export function dealStatusForStage(stage: string | null | undefined): DealStatus | null {
  switch (stage) {
    case 'customer':
    case 'subscriber':
      return 'win'
    case 'prospect':
    case 'lead':
      return 'open'
    default:
      return null
  }
}

/** Statusy szans firmy → etap, jaki z nich wynika. `null` = nic nie wynika. */
export function stageForDealStatuses(statuses: string[]): 'customer' | 'prospect' | null {
  if (statuses.includes('win')) return 'customer'
  if (statuses.some((status) => status === 'open' || status === 'in_progress')) return 'prospect'
  return null
}

export function dealTitleFor(company: CrmCompany): string {
  return `${company.displayName} — sprzedaż frakcji`
}

/**
 * Czysty plan zmian: co trzeba zrobić, żeby firmy i szanse znowu się zgadzały.
 * Nie dotyka bazy, więc da się go sprawdzić na sucho.
 */
export function planCrmSync(companies: CrmCompany[], deals: CrmDeal[]): CrmAction[] {
  const actions: CrmAction[] = []

  for (const company of companies) {
    const linked = deals.filter((deal) => deal.companyIds.includes(company.id))
    let stage = company.lifecycleStage

    // Szansa → firma.
    const derived = stageForDealStatuses(linked.map((deal) => deal.status))
    if (!stage && derived) {
      stage = derived
      actions.push({ kind: 'set-stage', companyId: company.id, stage, reason: 'etap wynika ze statusu szansy' })
    } else if (derived === 'customer' && stage && stage !== 'customer' && stage !== SUPPLIER_STAGE) {
      stage = 'customer'
      actions.push({ kind: 'set-stage', companyId: company.id, stage, reason: 'ma wygraną szansę' })
    }

    // Firma → szansa.
    if (stage === SUPPLIER_STAGE) {
      for (const deal of linked) {
        if (deal.companyIds.length > 1) {
          actions.push({
            kind: 'unlink-company',
            dealId: deal.id,
            companyId: company.id,
            companyIds: deal.companyIds.filter((id) => id !== company.id),
          })
        } else {
          actions.push({ kind: 'delete-deal', dealId: deal.id, reason: 'dostawca nie jest w lejku sprzedaży' })
        }
      }
      continue
    }

    const target = dealStatusForStage(stage)
    if (!target) continue
    if (linked.some((deal) => deal.status === target)) continue

    const managed = linked.find((deal) => deal.source === CRM_SYNC_SOURCE)
    if (managed) {
      actions.push({ kind: 'update-deal', dealId: managed.id, status: target })
    } else {
      actions.push({ kind: 'create-deal', companyId: company.id, status: target, title: dealTitleFor(company) })
    }
  }

  return actions
}

export type CrmSyncContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
}

export type CrmSyncOutcome = {
  action: CrmAction['kind']
  target: string
  ok: boolean
  error?: string
}

type PipelineStages = {
  pipelineId: string | null
  stageIdFor: (status: DealStatus) => string | null
}

async function loadPipelineStages(em: EntityManager, scope: TenantScope): Promise<PipelineStages> {
  const rows = await em.getConnection().execute<Array<{ pipeline_id: string; stage_id: string; name: string; position: number }>>(
    `select p.id as pipeline_id, s.id as stage_id, s.name, s.position
       from customer_pipelines p
       join customer_pipeline_stages s on s.pipeline_id = p.id
      where p.organization_id = ? and p.tenant_id = ?
      order by p.is_default desc, p.created_at asc, s.position asc`,
    [scope.organizationId, scope.tenantId],
  )
  if (!rows.length) return { pipelineId: null, stageIdFor: () => null }
  const pipelineId = rows[0].pipeline_id
  const stages = rows.filter((row) => row.pipeline_id === pipelineId)
  const winStage = stages.find((row) => row.name.trim().toLowerCase() === 'win') ?? null
  const firstStage = stages[0] ?? null
  return {
    pipelineId,
    stageIdFor: (status) => (status === 'win' ? winStage?.stage_id ?? null : firstStage?.stage_id ?? null),
  }
}

async function loadCompanies(em: EntityManager, scope: TenantScope): Promise<CrmCompany[]> {
  const rows = (await findWithDecryption(
    em,
    CustomerEntity,
    { organizationId: scope.organizationId, tenantId: scope.tenantId, kind: 'company', deletedAt: null } as never,
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )) as Array<{ id: string; displayName?: string | null; lifecycleStage?: string | null }>
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName ?? '',
    lifecycleStage: row.lifecycleStage?.trim() || null,
  }))
}

async function loadDeals(em: EntityManager, scope: TenantScope): Promise<CrmDeal[]> {
  const rows = await em.getConnection().execute<Array<{ id: string; status: string; source: string | null; company_ids: string[] | null }>>(
    `select d.id, d.status, d.source,
            array_remove(array_agg(dc.company_entity_id), null) as company_ids
       from customer_deals d
       left join customer_deal_companies dc on dc.deal_id = d.id
      where d.organization_id = ? and d.tenant_id = ? and d.deleted_at is null
      group by d.id`,
    [scope.organizationId, scope.tenantId],
  )
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    source: row.source,
    companyIds: row.company_ids ?? [],
  }))
}

/** Suma brutto zamówień odbiorcy — wartość szansy, kiedy już coś sprzedaliśmy. */
async function loadOrderTotals(em: EntityManager, scope: TenantScope): Promise<Map<string, number>> {
  const rows = await em.getConnection().execute<Array<{ customer_entity_id: string; total: string }>>(
    `select customer_entity_id, sum(grand_total_gross_amount) as total
       from sales_orders
      where organization_id = ? and tenant_id = ? and deleted_at is null and customer_entity_id is not null
      group by customer_entity_id`,
    [scope.organizationId, scope.tenantId],
  )
  return new Map(rows.map((row) => [row.customer_entity_id, Number.parseFloat(row.total) || 0]))
}

export async function syncCrm(ctx: CrmSyncContext): Promise<{ actions: CrmAction[]; outcomes: CrmSyncOutcome[] }> {
  const { em, scope } = ctx

  await ensureDictionaryEntry(em, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    kind: 'lifecycle_stage',
    value: SUPPLIER_STAGE,
    label: 'Dostawca',
    color: '#f59e0b',
  })
  await em.flush()

  const [companies, deals, stages, totals] = await Promise.all([
    loadCompanies(em, scope),
    loadDeals(em, scope),
    loadPipelineStages(em, scope),
    loadOrderTotals(em, scope),
  ])
  const actions = planCrmSync(companies, deals)
  const outcomes: CrmSyncOutcome[] = []
  const scoped = { organizationId: scope.organizationId, tenantId: scope.tenantId }

  for (const action of actions) {
    const target = 'companyId' in action ? action.companyId : action.dealId
    try {
      switch (action.kind) {
        case 'set-stage':
          await ctx.commandBus.execute('customers.companies.update', {
            input: { ...scoped, id: action.companyId, lifecycleStage: action.stage },
            ctx: ctx.commandContext,
          })
          break
        case 'create-deal': {
          const total = totals.get(action.companyId) ?? 0
          await ctx.commandBus.execute('customers.deals.create', {
            input: {
              ...scoped,
              title: action.title,
              status: action.status,
              pipelineId: stages.pipelineId ?? undefined,
              pipelineStageId: stages.stageIdFor(action.status) ?? undefined,
              probability: action.status === 'win' ? 100 : 20,
              valueAmount: total > 0 ? Math.round(total * 100) / 100 : undefined,
              valueCurrency: total > 0 ? 'PLN' : undefined,
              source: CRM_SYNC_SOURCE,
              companyIds: [action.companyId],
            },
            ctx: ctx.commandContext,
          })
          break
        }
        case 'update-deal':
          await ctx.commandBus.execute('customers.deals.update', {
            input: {
              ...scoped,
              id: action.dealId,
              status: action.status,
              pipelineStageId: stages.stageIdFor(action.status) ?? undefined,
              probability: action.status === 'win' ? 100 : 20,
            },
            ctx: ctx.commandContext,
          })
          break
        case 'unlink-company':
          await ctx.commandBus.execute('customers.deals.update', {
            input: { ...scoped, id: action.dealId, companyIds: action.companyIds },
            ctx: ctx.commandContext,
          })
          break
        case 'delete-deal':
          await ctx.commandBus.execute('customers.deals.delete', {
            input: { body: { id: action.dealId } },
            ctx: ctx.commandContext,
          })
          break
      }
      outcomes.push({ action: action.kind, target, ok: true })
    } catch (error) {
      outcomes.push({
        action: action.kind,
        target,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { actions, outcomes }
}

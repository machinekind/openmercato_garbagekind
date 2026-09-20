import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { InventoryLot } from '@open-mercato/core/modules/wms/data/entities'
import type { FractionIndex } from './fractions'
import type { LegacyMovementRow } from './legacyFiles'

/**
 * Partia odpadu: skąd wzięła się masa, która leży na placu.
 *
 * To jest ta rzecz, której w starym systemie nie było w ogóle, a której
 * w gospodarce odpadami wymaga się wprost. `stockmoves` mówi tylko, że
 * przyjechało 6 412 kg papieru. Nie mówi, czyjego - a kiedy okaże się, że
 * w partii był odpad niebezpieczny albo że odbiorca kwestionuje jakość
 * frakcji, pytanie brzmi zawsze tak samo: od kogo to przyjechało i kiedy.
 *
 * Każde `PZ` zakłada partię w WMS (`wms.lots.create`), a ruch przyjęcia ją
 * wskazuje (`lotId`). Dzięki temu identyfikowalność prowadzi sam magazyn,
 * a nie nasza tabela obok niego.
 */

export type LotContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
  fractions: FractionIndex
  /** `debtorno` → nazwa kontrahenta, żeby partia niosła nazwę, a nie sam kod. */
  supplierNames: Map<string, string>
}

/** `stkmoveno` przyjęcia → identyfikator partii w WMS. */
export type LotIndex = Map<number, string>

export type LotOutcome = {
  stkmoveno: number
  action: 'create' | 'skip' | 'failed'
  lotId?: string
  error?: string
}

/** Numer partii odtwarzalny z numeru przyjęcia - stąd idempotencja. */
export function lotNumberFor(stkmoveno: number): string {
  return `PZ/${stkmoveno}`
}

export async function loadLotIndex(em: EntityManager, scope: TenantScope): Promise<LotIndex> {
  const rows = await em.find(InventoryLot, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    lotNumber: { $like: 'PZ/%' },
  } as never)
  const index: LotIndex = new Map()
  for (const row of rows as Array<{ id: string; lotNumber: string }>) {
    const stkmoveno = Number.parseInt(row.lotNumber.slice(3), 10)
    if (Number.isFinite(stkmoveno)) index.set(stkmoveno, row.id)
  }
  return index
}

function parseMoment(value: string): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Zakłada partie dla przyjęć, których jeszcze nie ma.
 *
 * Bierze wyłącznie wiersze `PZ`: partia powstaje przy wjeździe odpadu na
 * teren zakładu. Sortowanie i wydanie tylko ją przenoszą albo zdejmują.
 */
export async function ensureLots(
  ctx: LotContext,
  rows: LegacyMovementRow[],
): Promise<{ index: LotIndex; outcomes: LotOutcome[] }> {
  const index = await loadLotIndex(ctx.em, ctx.scope)
  const outcomes: LotOutcome[] = []

  for (const row of rows) {
    if (row.typ !== 'PZ') continue
    if (index.has(row.stkmoveno)) {
      outcomes.push({ stkmoveno: row.stkmoveno, action: 'skip', lotId: index.get(row.stkmoveno) })
      continue
    }

    const fraction = ctx.fractions.get(row.stockid)
    if (!fraction) {
      outcomes.push({
        stkmoveno: row.stkmoveno,
        action: 'failed',
        error: `frakcja ${row.stockid} nie jest w katalogu`,
      })
      continue
    }

    const dostawca = ctx.supplierNames.get(row.debtorno) ?? row.debtorno

    try {
      const created = (await ctx.commandBus.execute('wms.lots.create', {
        input: {
          organizationId: ctx.scope.organizationId,
          tenantId: ctx.scope.tenantId,
          catalogVariantId: fraction.variantId,
          sku: row.stockid,
          lotNumber: lotNumberFor(row.stkmoveno),
          // Data „wyprodukowania" partii to moment przyjęcia odpadu na plac.
          // W gospodarce odpadami liczy się właśnie ta data, bo od niej biegną
          // terminy magazynowania.
          manufacturedAt: parseMoment(row.data),
          status: 'available',
          metadata: {
            dostawca,
            kodOdpadu: row.stockid,
            masaPrzyjeciaKg: Math.abs(row.iloscKg),
            legacy: { stkmoveno: row.stkmoveno, debtorno: row.debtorno || null, typ: row.typ },
          },
        },
        ctx: ctx.commandContext,
      })) as { result?: { lotId?: string } } | undefined

      const lotId = created?.result?.lotId
      if (!lotId) {
        outcomes.push({ stkmoveno: row.stkmoveno, action: 'failed', error: 'komenda nie zwróciła identyfikatora partii' })
        continue
      }
      index.set(row.stkmoveno, lotId)
      outcomes.push({ stkmoveno: row.stkmoveno, action: 'create', lotId })
    } catch (error) {
      outcomes.push({
        stkmoveno: row.stkmoveno,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { index, outcomes }
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { registerCommand, type CommandBus, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { Reconciliation, WorkBatch, WorkOrder, type BatchStatus, type WorkOrderStatus } from '../data/entities'
import { DEFAULT_TOLERANCE_RATIO, reconcile } from '../lib/reconcile'
import { emitWorkOrdersEvent } from '../events'

/**
 * Komendy mostu hala ↔ przedsiębiorstwo.
 *
 * Wszystko idzie szyną komend, tak jak w pozostałych modułach. Tutaj dochodzi
 * powód dodatkowy: zamknięcie partii **wywołuje komendy magazynowe platformy**
 * (`wms.lots.create`, `wms.inventory.receive`), a nie pisze do tabel magazynu.
 * Identyfikowalność prowadzi magazyn, nie my obok niego - ta sama zasada,
 * co przy imporcie z systemu legacy w module `sortownia`.
 */

const scoped = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
})

function resolveEm(ctx: { container: { resolve: (key: string) => unknown } }): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

/* ------------------------------------------------------------------ */

export const openOrderSchema = scoped.extend({
  orderNumber: z.string().trim().min(1).max(64),
  cellId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  sku: z.string().trim().min(1).max(64),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid(),
  targetGrams: z.number().int().positive(),
  nominalPieceGrams: z.number().int().positive().nullable().optional(),
  policyVersionId: z.string().uuid().nullable().optional(),
  salesOrderId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
})

export type OpenOrderInput = z.infer<typeof openOrderSchema>

const openOrderCommand: CommandHandler<OpenOrderInput, { workOrderId: string }> = {
  id: 'work_orders.orders.open',
  async execute(rawInput, ctx) {
    const input = openOrderSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const istnieje = await em.findOne(WorkOrder, {
      tenantId: input.tenantId,
      orderNumber: input.orderNumber,
    } as never)
    if (istnieje) throw new Error(`Zlecenie ${input.orderNumber} już istnieje.`)

    const order = em.create(WorkOrder, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      orderNumber: input.orderNumber,
      cellId: input.cellId,
      policyVersionId: input.policyVersionId ?? null,
      catalogVariantId: input.catalogVariantId,
      sku: input.sku,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      targetGrams: input.targetGrams,
      nominalPieceGrams: input.nominalPieceGrams ?? null,
      salesOrderId: input.salesOrderId ?? null,
      status: 'open' as WorkOrderStatus,
      openedBy: ctx.auth?.sub ?? null,
      notes: input.notes ?? null,
    } as never)
    em.persist(order)
    await em.flush()

    const workOrderId = (order as unknown as { id: string }).id
    await emitWorkOrdersEvent('work_orders.order.opened', {
      id: workOrderId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      orderNumber: input.orderNumber,
      cellId: input.cellId,
      sku: input.sku,
      targetGrams: input.targetGrams,
      policyVersionId: input.policyVersionId ?? null,
      salesOrderId: input.salesOrderId ?? null,
    })

    return { workOrderId }
  },
}

/* ------------------------------------------------------------------ */

export const openBatchSchema = scoped.extend({
  workOrderId: z.string().uuid(),
  containerCode: z.string().trim().min(1).max(64),
  openedAt: z.coerce.date().optional(),
})

export type OpenBatchInput = z.infer<typeof openBatchSchema>

const openBatchCommand: CommandHandler<OpenBatchInput, { batchId: string; openedAt: Date }> = {
  id: 'work_orders.batches.open',
  async execute(rawInput, ctx) {
    const input = openBatchSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const order = (await em.findOne(WorkOrder, {
      id: input.workOrderId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as { id: string; status: WorkOrderStatus; organizationId: string } | null
    if (!order) throw new Error('Zlecenie robocze nie istnieje.')
    if (order.status !== 'open') throw new Error(`Zlecenie jest w stanie ${order.status} - nie przyjmuje partii.`)

    /*
     * Jedna otwarta partia na zlecenie. Dwie naraz nie dałyby się rozdzielić:
     * epizody wiąże z partią okno czasowe, więc nakładające się okna
     * przypisałyby ten sam chwyt do dwóch pojemników.
     */
    const otwarta = await em.findOne(WorkBatch, {
      workOrderId: input.workOrderId,
      status: 'filling',
    } as never)
    if (otwarta) throw new Error('Zlecenie ma już otwartą partię - zamknij ją przed otwarciem następnej.')

    const openedAt = input.openedAt ?? new Date()
    const batch = em.create(WorkBatch, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      containerCode: input.containerCode,
      openedAt,
      status: 'filling' as BatchStatus,
    } as never)
    em.persist(batch)
    await em.flush()

    const batchId = (batch as unknown as { id: string }).id
    await emitWorkOrdersEvent('work_orders.batch.opened', {
      id: batchId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      containerCode: input.containerCode,
      openedAt: openedAt.toISOString(),
    })

    return { batchId, openedAt }
  },
}

/* ------------------------------------------------------------------ */

export const closeBatchSchema = scoped.extend({
  batchId: z.string().uuid(),
  /** Masa z wagi, w gramach. To ona staje się zapasem. */
  weighedGrams: z.number().int().nonnegative(),
  closedAt: z.coerce.date().optional(),
  toleranceRatio: z.number().positive().max(1).optional(),
  /**
   * Kto zważył. Magazyn platformy wymaga realnego użytkownika przy ruchu
   * i ma rację: przyjęcie bez wykonawcy jest zapisem, za który nikt nie
   * odpowiada. Pole jest tu opcjonalne wyłącznie dlatego, że przy wywołaniu
   * z sesji wystarcza `ctx.auth` - komenda nigdy nie podstawia aktora sama.
   */
  performedBy: z.string().uuid().optional(),
})

export type CloseBatchInput = z.infer<typeof closeBatchSchema>

export type CloseBatchResult = {
  batchId: string
  claimedPieces: number
  weighedGrams: number
  expectedGrams: number | null
  driftGrams: number | null
  verdict: string
  reason: string
  requiresReview: boolean
  lotId: string | null
  lotNumber: string | null
}

const closeBatchCommand: CommandHandler<CloseBatchInput, CloseBatchResult> = {
  id: 'work_orders.batches.close',
  async execute(rawInput, ctx) {
    const input = closeBatchSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)
    const closedAt = input.closedAt ?? new Date()

    const batch = (await em.findOne(WorkBatch, {
      id: input.batchId,
      tenantId: input.tenantId,
    } as never)) as unknown as {
      id: string
      workOrderId: string
      containerCode: string
      openedAt: Date
      status: BatchStatus
      closedAt?: Date | null
      weighedGrams?: number | null
      claimedPieces?: number | null
      lotId?: string | null
      lotNumber?: string | null
    } | null
    if (!batch) throw new Error('Partia nie istnieje.')
    if (batch.status !== 'filling') throw new Error(`Partia jest w stanie ${batch.status} - nie da się jej zamknąć.`)
    if (closedAt.getTime() <= batch.openedAt.getTime()) {
      throw new Error('Moment zamknięcia partii musi być późniejszy niż jej otwarcie.')
    }

    const order = (await em.findOne(WorkOrder, {
      id: batch.workOrderId,
      tenantId: input.tenantId,
    } as never)) as unknown as {
      id: string
      organizationId: string
      cellId: string
      policyVersionId?: string | null
      catalogVariantId: string
      sku: string
      warehouseId: string
      locationId: string
      nominalPieceGrams?: number | null
      orderNumber: string
    } | null
    if (!order) throw new Error('Zlecenie robocze partii nie istnieje.')

    /**
     * Deklaracja robota: epizody zakończone powodzeniem w oknie partii.
     *
     * Wiązanie po oknie czasowym i celi, a nie po kluczu obcym - robot nie wie,
     * do którego pojemnika trafiła sztuka, i udawanie, że wie, byłoby
     * wymyślaniem danych. Filtr po wersji polityki zawęża rachunek, gdy
     * zlecenie ją wskazuje: wtedy błąd przypisuje się **tej** wersji.
     */
    const warunekPolityki = order.policyVersionId ? 'and e.policy_version_id = ?' : ''
    const parametry: unknown[] = [input.tenantId, order.cellId, batch.openedAt, closedAt]
    if (order.policyVersionId) parametry.push(order.policyVersionId)

    const liczba = await em.getConnection().execute<Array<{ claimed: string }>>(
      `select count(*) as claimed
         from episodes_episodes e
        where e.tenant_id = ?
          and e.cell_id = ?
          and e.outcome = 'success'
          and e.started_at >= ?
          and e.started_at < ?
          ${warunekPolityki}`,
      parametry,
    )
    const claimedPieces = Number(liczba?.[0]?.claimed ?? 0)

    const verdict = reconcile({
      claimedPieces,
      nominalPieceGrams: order.nominalPieceGrams ?? null,
      weighedGrams: input.weighedGrams,
      toleranceRatio: input.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO,
    })

    const performedBy = input.performedBy ?? ctx.auth?.sub ?? null
    if (input.weighedGrams > 0 && !performedBy) {
      // Świadoma odmowa zamiast podstawienia „pierwszego lepszego" użytkownika.
      // Ruch magazynowy bez wykonawcy to masa, która pojawiła się sama.
      throw new Error(
        'Zamknięcie partii z niezerową masą wymaga wykonawcy: podaj performedBy albo wywołaj z sesji użytkownika.',
      )
    }

    const bus = ctx.container.resolve('commandBus') as CommandBus
    let lotId: string | null = null
    const lotNumber = `${order.orderNumber}/${batch.containerCode}`

    /**
     * Materiał wchodzi do magazynu **niezależnie od werdyktu**.
     *
     * Kusi, żeby wstrzymać przyjęcie przy rozjeździe - i byłby to błąd.
     * Pojemnik stoi na wadze, materiał fizycznie istnieje. Magazyn, który
     * go nie przyjmuje, zapisuje nieprawdę, a operator i tak wysypie
     * zawartość na hałdę. Werdykt dotyczy maszyny, nie materiału.
     */
    if (input.weighedGrams > 0) {
      const lot = (await bus.execute('wms.lots.create', {
        input: {
          organizationId: order.organizationId,
          tenantId: input.tenantId,
          catalogVariantId: order.catalogVariantId,
          sku: order.sku,
          lotNumber,
          manufacturedAt: closedAt,
          status: 'available',
          metadata: {
            zlecenie: order.orderNumber,
            pojemnik: batch.containerCode,
            cellId: order.cellId,
            policyVersionId: order.policyVersionId ?? null,
            // Deklaracja robota ląduje w metadanych partii, a nie w ilości.
            deklarowaneSztuki: claimedPieces,
            werdyktUzgodnienia: verdict.verdict,
          },
        },
        ctx,
      })) as { result?: { lotId?: string } } | undefined
      lotId = lot?.result?.lotId ?? null

      await bus.execute('wms.inventory.receive', {
        input: {
          organizationId: order.organizationId,
          tenantId: input.tenantId,
          warehouseId: order.warehouseId,
          locationId: order.locationId,
          catalogVariantId: order.catalogVariantId,
          // Kilogramy na granicy: w naszej księdze prawdą są gramy całkowite.
          quantity: input.weighedGrams / 1000,
          lotId,
          /**
           * `manual`, bo słownik odniesień w WMS platformy nie ma pozycji
           * na **produkcję własną**: dopuszcza zakup, sprzedaż, przesunięcie,
           * ręczne, kontrolę jakości i zwrot. Materiał wytworzony na miejscu
           * przez własną maszynę nie mieści się w żadnej z nich.
           *
           * Wybieramy najmniej fałszywą i zapisujemy prawdziwe pochodzenie
           * w `metadata`. Naciąganie `po` (zakup) byłoby gorsze: zrobiłoby
           * z własnej produkcji dostawę od kontrahenta, którego nie ma.
           */
          referenceType: 'manual',
          // Identyfikatorem odniesienia jest partia robocza - to ona jest
          // rzeczą, do której można wrócić z magazynu.
          referenceId: batch.id,
          performedBy,
          performedAt: closedAt,
          receivedAt: closedAt,
          reason: `Zamknięcie partii roboczej ${batch.containerCode} (zlecenie ${order.orderNumber})`,
          metadata: {
            pochodzenie: 'produkcja_wlasna',
            workOrderId: order.id,
            batchId: batch.id,
            containerCode: batch.containerCode,
            orderNumber: order.orderNumber,
            claimedPieces,
          },
        },
        ctx,
      })
    }

    em.persist(
      em.create(Reconciliation, {
        organizationId: order.organizationId,
        tenantId: input.tenantId,
        batchId: batch.id,
        policyVersionId: order.policyVersionId ?? null,
        claimedPieces,
        nominalPieceGrams: order.nominalPieceGrams ?? null,
        expectedGrams: verdict.expectedGrams,
        weighedGrams: input.weighedGrams,
        driftGrams: verdict.driftGrams,
        driftRatio: verdict.driftRatio,
        verdict: verdict.verdict,
        reason: verdict.reason,
        toleranceRatio: verdict.toleranceRatio,
      } as never),
    )

    batch.status = 'closed' as BatchStatus
    batch.closedAt = closedAt
    batch.weighedGrams = input.weighedGrams
    batch.claimedPieces = claimedPieces
    batch.lotId = lotId
    batch.lotNumber = input.weighedGrams > 0 ? lotNumber : null
    await em.flush()

    await emitWorkOrdersEvent('work_orders.batch.closed', {
      id: batch.id,
      organizationId: order.organizationId,
      tenantId: input.tenantId,
      workOrderId: order.id,
      weighedGrams: input.weighedGrams,
      claimedPieces,
      expectedGrams: verdict.expectedGrams,
      driftGrams: verdict.driftGrams,
      verdict: verdict.verdict,
      lotNumber: batch.lotNumber ?? null,
    })

    /*
     * Osobne zdarzenie wyzwalane werdyktem, nie flagą `requiresReview`.
     * `requiresReview` jest decyzją o skierowaniu **maszyny** do przeglądu
     * i może być wyciszona progiem; werdykt jest tym, co zmierzono.
     * Odbiorca statystyczny potrzebuje pomiaru, a nie cudzej decyzji o progu.
     */
    if (verdict.verdict !== 'ok') {
      await emitWorkOrdersEvent('work_orders.batch.drift_detected', {
        id: batch.id,
        organizationId: order.organizationId,
        tenantId: input.tenantId,
        workOrderId: order.id,
        policyVersionId: order.policyVersionId ?? null,
        weighedGrams: input.weighedGrams,
        expectedGrams: verdict.expectedGrams,
        driftGrams: verdict.driftGrams,
        driftRatio: verdict.driftRatio,
        verdict: verdict.verdict,
        reason: verdict.reason,
      })
    }

    return {
      batchId: batch.id,
      claimedPieces,
      weighedGrams: input.weighedGrams,
      expectedGrams: verdict.expectedGrams,
      driftGrams: verdict.driftGrams,
      verdict: verdict.verdict,
      reason: verdict.reason,
      requiresReview: verdict.requiresReview,
      lotId,
      lotNumber: batch.lotNumber ?? null,
    }
  },
}

/* ------------------------------------------------------------------ */

export const closeOrderSchema = scoped.extend({
  workOrderId: z.string().uuid(),
  status: z.enum(['completed', 'cancelled']).default('completed'),
  notes: z.string().trim().max(1000).optional(),
})

export type CloseOrderInput = z.infer<typeof closeOrderSchema>

const closeOrderCommand: CommandHandler<
  CloseOrderInput,
  { workOrderId: string; producedGrams: number; batches: number }
> = {
  id: 'work_orders.orders.close',
  async execute(rawInput, ctx) {
    const input = closeOrderSchema.parse(rawInput ?? {})
    const em = resolveEm(ctx)

    const order = (await em.findOne(WorkOrder, {
      id: input.workOrderId,
      tenantId: input.tenantId,
      deletedAt: null,
    } as never)) as unknown as {
      id: string
      status: WorkOrderStatus
      closedAt?: Date | null
      notes?: string | null
    } | null
    if (!order) throw new Error('Zlecenie robocze nie istnieje.')
    if (order.status !== 'open') throw new Error(`Zlecenie jest już w stanie ${order.status}.`)

    const otwarta = await em.findOne(WorkBatch, {
      workOrderId: input.workOrderId,
      status: 'filling',
    } as never)
    if (otwarta) {
      // Pojemnik w trakcie napełniania niesie materiał, którego nikt nie zważył.
      // Zamknięcie zlecenia ponad nim zgubiłoby tę masę bez śladu.
      throw new Error('Zlecenie ma otwartą partię - zamknij ją (zważ) przed zamknięciem zlecenia.')
    }

    const suma = (await em.find(WorkBatch, {
      workOrderId: input.workOrderId,
      status: 'closed',
    } as never)) as unknown as Array<{ weighedGrams?: number | null }>

    order.status = input.status as WorkOrderStatus
    order.closedAt = new Date()
    if (input.notes) order.notes = input.notes
    await em.flush()

    const producedGrams = suma.reduce((acc, batch) => acc + Number(batch.weighedGrams ?? 0), 0)
    await emitWorkOrdersEvent('work_orders.order.closed', {
      id: order.id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      status: input.status,
      producedGrams,
      batches: suma.length,
    })

    return {
      workOrderId: order.id,
      producedGrams,
      batches: suma.length,
    }
  },
}

registerCommand(openOrderCommand)
registerCommand(openBatchCommand)
registerCommand(closeBatchCommand)
registerCommand(closeOrderCommand)

export { openOrderCommand, openBatchCommand, closeBatchCommand, closeOrderCommand }

import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { RobotCell, RobotPickTask, RobotTaskEvent } from '../data/entities'
import { TERMINAL_STATUSES, type PickStage, type TaskStatus } from '../data/validators'
import { emitRoboticsEvent } from '../events'

export type TenantScope = { tenantId?: string | null; organizationId?: string | null }

export type QueueInput = TenantScope & {
  cellId: string
  instruction: string
  targetLabel: string
  dropPreset?: string | null
  priority: number
  maxAttempts: number
  sourceRef?: string | null
}

export class PickTaskError extends Error {}

/** A task the bridge may act on, shaped the way bridge/om_bridge expects it. */
export type ClaimedTask = {
  id: string
  cellId: string
  instruction: string
  targetLabel: string
  dropPreset: string | null
  maxAttempts: number
  metadata: Record<string, unknown>
}

function scopeWhere(scope: TenantScope): Record<string, unknown> {
  const where: Record<string, unknown> = { deletedAt: null }
  if (scope.tenantId) where.tenantId = scope.tenantId
  if (scope.organizationId) where.organizationId = scope.organizationId
  return where
}

export function createPickTaskService({ em }: { em: EntityManager }) {
  async function trace(
    task: RobotPickTask,
    kind: string,
    message: string,
    stage: string | null,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    em.persist(
      em.create(RobotTaskEvent, {
        taskId: task.id,
        kind,
        stage,
        message,
        payload,
        tenantId: task.tenantId ?? null,
        organizationId: task.organizationId ?? null,
      }),
    )
  }

  async function requireTask(taskId: string, scope: TenantScope): Promise<RobotPickTask> {
    const task = await em.findOne(RobotPickTask, { id: taskId, ...scopeWhere(scope) })
    if (!task) throw new PickTaskError(`pick task ${taskId} not found`)
    return task
  }

  return {
    /** Put work on a cell's queue. The arm is not touched here. */
    async queue(input: QueueInput): Promise<RobotPickTask> {
      const cell = await em.findOne(RobotCell, { id: input.cellId, ...scopeWhere(input) })
      if (!cell) throw new PickTaskError(`robot cell ${input.cellId} not found`)
      if (!cell.isActive) throw new PickTaskError(`robot cell ${cell.name} is not accepting work`)

      const task = em.create(RobotPickTask, {
        cellId: cell.id,
        instruction: input.instruction,
        targetLabel: input.targetLabel,
        dropPreset: input.dropPreset ?? null,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        sourceRef: input.sourceRef ?? null,
        status: 'queued' satisfies TaskStatus,
        tenantId: input.tenantId ?? null,
        organizationId: input.organizationId ?? null,
      })
      em.persist(task)
      await trace(task, 'status', `queued: ${input.instruction}`, null, { priority: input.priority })
      await em.flush()

      await emitRoboticsEvent('robotics.pick_task.queued', {
        id: task.id,
        cellId: cell.id,
        instruction: task.instruction,
      })
      return task
    },

    /**
     * Hand the next queued task to a bridge process.
     *
     * Row-locked and single-shot: two bridges pointed at the same cell is a
     * configuration mistake, but it must not turn into two processes driving
     * one arm.
     */
    async claimNext(cellId: string, bridge: string, scope: TenantScope): Promise<ClaimedTask | null> {
      return em.transactional(async (tem) => {
        const task = await tem.findOne(
          RobotPickTask,
          { cellId, status: 'queued', ...scopeWhere(scope) },
          { orderBy: { priority: 'DESC', createdAt: 'ASC' }, lockMode: LockMode.PESSIMISTIC_WRITE },
        )
        if (!task) return null

        task.status = 'claimed'
        task.claimedAt = new Date()
        task.attempts += 1
        task.detail = `claimed by ${bridge}`
        tem.persist(
          tem.create(RobotTaskEvent, {
            taskId: task.id,
            kind: 'status',
            stage: null,
            message: `claimed by ${bridge} (attempt ${task.attempts}/${task.maxAttempts})`,
            payload: { bridge },
            tenantId: task.tenantId ?? null,
            organizationId: task.organizationId ?? null,
          }),
        )
        await tem.flush()

        await emitRoboticsEvent('robotics.pick_task.claimed', { id: task.id, cellId, bridge })
        return {
          id: task.id,
          cellId: task.cellId,
          instruction: task.instruction,
          targetLabel: task.targetLabel,
          dropPreset: task.dropPreset ?? null,
          maxAttempts: task.maxAttempts,
          metadata: { attempt: task.attempts, sourceRef: task.sourceRef ?? null },
        }
      })
    },

    /** Record one stage transition reported by the bridge. */
    async report(
      taskId: string,
      stage: PickStage,
      message: string,
      kind: string,
      payload: Record<string, unknown> | null,
      scope: TenantScope,
    ): Promise<RobotPickTask> {
      const task = await requireTask(taskId, scope)
      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
        throw new PickTaskError(`pick task ${taskId} already ${task.status}`)
      }
      task.status = 'running'
      task.stage = stage
      task.detail = message
      await trace(task, kind, message, stage, payload)
      await em.flush()

      await emitRoboticsEvent('robotics.pick_task.progress', { id: task.id, stage, message })
      return task
    },

    /** Close a task. Terminal states are final; a retry is a new task. */
    async finish(
      taskId: string,
      status: Extract<TaskStatus, 'succeeded' | 'failed' | 'aborted'>,
      detail: string,
      payload: Record<string, unknown> | null,
      scope: TenantScope,
    ): Promise<RobotPickTask> {
      const task = await requireTask(taskId, scope)
      if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) return task

      task.status = status
      task.stage = status === 'succeeded' ? 'done' : task.stage
      task.detail = detail || status
      task.finishedAt = new Date()
      await trace(task, status === 'succeeded' ? 'status' : 'alert', detail || status, task.stage ?? null, payload)
      await em.flush()

      await emitRoboticsEvent('robotics.pick_task.finished', { id: task.id, status, detail: task.detail })
      return task
    },

    /**
     * Operator-side stop. This only marks the record: the arm is stopped by the
     * panel's own Stop button or by the bridge noticing the aborted status -
     * ceasing to transmit is the safe failure mode, and the panel owns it.
     */
    async abort(taskId: string, reason: string, scope: TenantScope): Promise<RobotPickTask> {
      return this.finish(taskId, 'aborted', reason, null, scope)
    },

    /** Bridge heartbeat, so the UI can grey out a cell nobody is driving. */
    async touchCell(cellId: string, scope: TenantScope): Promise<void> {
      const cell = await em.findOne(RobotCell, { id: cellId, ...scopeWhere(scope) })
      if (!cell) throw new PickTaskError(`robot cell ${cellId} not found`)
      cell.lastSeenAt = new Date()
      await em.flush()
    },
  }
}

export type PickTaskService = ReturnType<typeof createPickTaskService>

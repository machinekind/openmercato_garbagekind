import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

/**
 * A robot cell: one arm plus the web panel that fronts it.
 *
 * The panel URL is the whole integration surface. Open Mercato never speaks
 * CAN, never holds a joint target and never decides whether the arm may move -
 * it hands work to a cell and records what came back.
 */
@Entity({ tableName: 'robot_cells' })
export class RobotCell {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ type: 'text' })
  name!: string

  /** Base URL of the arm's web panel, e.g. http://10.42.0.1:8080 */
  @Property({ name: 'panel_base_url', type: 'text' })
  panelBaseUrl!: string

  /** Preset the arm returns to between tasks. Must exist in the panel's presets.json. */
  @Property({ name: 'home_preset', type: 'text', default: 'home' })
  homePreset: string = 'home'

  /** Preset the arm looks from while searching for the target. */
  @Property({ name: 'search_preset', type: 'text', default: 'table' })
  searchPreset: string = 'table'

  /** Set false to keep a cell on record while refusing new work. */
  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  /** Last heartbeat from the bridge process that drives this cell. */
  @Property({ name: 'last_seen_at', type: Date, nullable: true })
  lastSeenAt?: Date | null

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * One pick request handed to a cell: "grab the can".
 *
 * `status` is the queue state the app owns; `stage` is the last thing the arm
 * reported from inside an attempt. They move independently on purpose - a task
 * can be `running` for a while with the stage walking approaching -> grasping.
 */
@Entity({ tableName: 'robot_pick_tasks' })
@Index({ name: 'robot_pick_tasks_queue_idx', properties: ['cellId', 'status', 'priority'] })
export class RobotPickTask {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'cell_id', type: 'uuid' })
  cellId!: string

  /** Natural-language command sent to the policy, e.g. "pick up the can". */
  @Property({ type: 'text' })
  instruction!: string

  /** Detector class the perception step looks for, e.g. "can". */
  @Property({ name: 'target_label', type: 'text', default: 'can' })
  targetLabel: string = 'can'

  /** Preset to move to before releasing the object; null = keep holding it. */
  @Property({ name: 'drop_preset', type: 'text', nullable: true })
  dropPreset?: string | null

  /** queued | claimed | running | succeeded | failed | aborted */
  @Property({ type: 'text', default: 'queued' })
  status: string = 'queued'

  /** engaging | searching | approaching | grasping | lifting | retreating | done */
  @Property({ type: 'text', nullable: true })
  stage?: string | null

  @Property({ type: 'integer', default: 0 })
  priority: number = 0

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0

  @Property({ name: 'max_attempts', type: 'integer', default: 1 })
  maxAttempts: number = 1

  /** Last human-readable line from the bridge; the failure reason when failed. */
  @Property({ type: 'text', nullable: true })
  detail?: string | null

  /** Whatever queued this: an order line, a WMS move, a chat message. */
  @Property({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef?: string | null

  @Property({ name: 'claimed_at', type: Date, nullable: true })
  claimedAt?: Date | null

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Append-only trace of what the arm did for a task.
 *
 * The panel's own event bus is a ring buffer that dies with the process; this
 * is the part an operator still needs tomorrow when asked why a pick failed.
 */
@Entity({ tableName: 'robot_task_events' })
@Index({ name: 'robot_task_events_task_idx', properties: ['taskId', 'createdAt'] })
export class RobotTaskEvent {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'task_id', type: 'uuid' })
  taskId!: string

  /** stage | status | alert | log */
  @Property({ type: 'text', default: 'log' })
  kind: string = 'log'

  @Property({ type: 'text', nullable: true })
  stage?: string | null

  @Property({ type: 'text' })
  message!: string

  /** Joint pose, detector boxes, panel refusal - whatever the bridge attached. */
  @Property({ type: 'json', nullable: true })
  payload?: Record<string, unknown> | null

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

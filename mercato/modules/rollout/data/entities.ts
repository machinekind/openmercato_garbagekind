import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Wdrożenie etapowe z bramą opartą na liczbach z księgi epizodów.
 *
 * Trzy rozstrzygnięcia:
 *
 * 1. **Próg mieszka na etapie, nie na wdrożeniu.** Pierwszy etap na trzech
 *    robotach i ostatni na całej flocie nie mają tego samego progu i nie
 *    powinny mieć. Jeden próg dla całego wdrożenia zmusza do ustawienia go
 *    pod etap ostatni, czyli do przepuszczenia wszystkiego wcześniej.
 *
 * 2. **Poprzednia wersja polityki jest zapisana przy każdym robocie.**
 *    Wycofanie ma być mechaniczne. Odtwarzanie „co tam było wcześniej"
 *    z historii przypisań jest wykonalne i dokładnie dlatego złe: wycofanie
 *    wykonuje się wtedy, gdy coś się pali, i nie może zależeć od zapytania,
 *    które akurat wtedy zwróci dwa wiersze.
 *
 * 3. **Dziennik bramy jest dopisywany, nigdy nadpisywany.** Brama oceniana
 *    trzy razy zostawia trzy wpisy. Nadpisywanie ostatniego kasowałoby
 *    odpowiedź na pytanie, ile razy wdrożenie ocierało się o próg, zanim go
 *    przekroczyło - a to jest jedyna rzecz, którą widać zawczasu.
 */

export type RolloutStatus = 'planned' | 'running' | 'halted' | 'completed' | 'rolled_back'
export type StageStatus = 'pending' | 'running' | 'passed' | 'halted' | 'rolled_back'
export type RolloutMode = 'shadow' | 'active'

@Entity({ tableName: 'rollout_rollouts' })
@Index({ name: 'rollout_rollouts_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'rollout_rollouts_version_idx', properties: ['policyVersionId'] })
export class Rollout {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  /**
   * Tryb wdrożenia.
   *
   * `shadow` ma zapisane ograniczenie w `lib/gate.ts`: cień nie dowodzi
   * bezpieczeństwa dla polityki zmieniającej stan świata, a polityka sterująca
   * manipulatorem zmienia go z definicji.
   */
  @Property({ type: 'text', default: 'active' })
  mode: RolloutMode = 'active'

  @Property({ type: 'text', default: 'planned' })
  status: RolloutStatus = 'planned'

  @Property({ name: 'status_reason', type: 'text', nullable: true })
  statusReason?: string | null

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'rollout_stages' })
@Index({ name: 'rollout_stages_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'rollout_stages_ordinal_unique', properties: ['rolloutId', 'ordinal'] })
export class RolloutStage {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'rollout_id', type: 'uuid' })
  rolloutId!: string

  @Property({ type: 'int' })
  ordinal!: number

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', default: 'pending' })
  status: StageStatus = 'pending'

  /** Progi bramy zamrożone przy zakładaniu etapu - patrz komentarz przy klasie. */
  @Property({ name: 'min_episodes', type: 'int' })
  minEpisodes!: number

  @Property({ name: 'max_intervention_rate', type: 'text' })
  maxInterventionRate!: string

  @Property({ name: 'max_severe_rate', type: 'text' })
  maxSevereRate!: string

  @Property({ name: 'min_success_rate', type: 'text' })
  minSuccessRate!: string

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Robot objęty etapem, z zapisaną wersją poprzednią.
 *
 * `previous_policy_version_id` jest nullowalne: robot bez wcześniejszego
 * przypisania po wycofaniu wraca do stanu „bez polityki", a nie do wersji
 * wymyślonej. `null` jest tu poprawną wartością docelową, nie brakiem danych.
 */
@Entity({ tableName: 'rollout_stage_members' })
@Index({ name: 'rollout_members_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'rollout_members_stage_idx', properties: ['stageId'] })
@Unique({ name: 'rollout_members_unique', properties: ['stageId', 'robotId'] })
export class StageMember {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'stage_id', type: 'uuid' })
  stageId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'previous_policy_version_id', type: 'uuid', nullable: true })
  previousPolicyVersionId?: string | null

  @Property({ name: 'applied_at', type: Date, nullable: true })
  appliedAt?: Date | null

  @Property({ name: 'rolled_back_at', type: Date, nullable: true })
  rolledBackAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Wpis dziennika bramy - dopisywany, nigdy nadpisywany.
 *
 * Trzyma zmierzone wartości, nie tylko werdykt. Dziennik z samym „rollback"
 * wymaga przeliczenia księgi wstecz, żeby powiedzieć dlaczego - a księga
 * w międzyczasie urosła.
 */
@Entity({ tableName: 'rollout_gate_evaluations' })
@Index({ name: 'rollout_gates_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'rollout_gates_stage_idx', properties: ['stageId', 'evaluatedAt'] })
export class GateEvaluation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'rollout_id', type: 'uuid' })
  rolloutId!: string

  @Property({ name: 'stage_id', type: 'uuid' })
  stageId!: string

  @Property({ type: 'text' })
  decision!: string

  @Property({ type: 'text' })
  reason!: string

  @Property({ type: 'int' })
  episodes!: number

  @Property({ name: 'intervention_rate', type: 'text' })
  interventionRate!: string

  @Property({ name: 'severe_rate', type: 'text' })
  severeRate!: string

  @Property({ name: 'success_rate', type: 'text' })
  successRate!: string

  @Property({ type: 'json', nullable: true })
  breached?: string[] | null

  /**
   * Kto ocenił bramę. `null` znaczy: automat.
   *
   * W poprawnie działającym wdrożeniu ta kolumna jest pusta przy każdym
   * wpisie. Podpis człowieka przy wycofaniu oznacza, że automat nie zdążył -
   * i to też jest informacja.
   */
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'evaluated_at', type: Date, onCreate: () => new Date() })
  evaluatedAt: Date = new Date()
}

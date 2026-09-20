import { Migration } from '@mikro-orm/migrations'

/**
 * Wdrożenia etapowe - schemat początkowy.
 *
 * Progi są kolumnami **etapu**, nie wdrożenia. Pierwszy etap na trzech
 * robotach i ostatni na całej flocie nie mają tego samego progu i nie powinny
 * mieć; jeden próg dla całego wdrożenia zmusza do ustawienia go pod etap
 * ostatni, czyli do przepuszczenia wszystkiego wcześniej.
 *
 * Wskaźniki trzymamy jako `numeric`, nie `double precision`: to są liczby,
 * które trafiają do dziennika audytu i muszą wyglądać tak samo po odczycie,
 * jak przy zapisie.
 */
export class Migration20260919200000_rollout extends Migration {
  override name = 'Migration20260919200000_rollout'

  override up(): void | Promise<void> {
    this.addSql(`create table "rollout_rollouts" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "name" text not null,
      "policy_version_id" uuid not null,
      "mode" text not null default 'active',
      "status" text not null default 'planned',
      "status_reason" text null,
      "started_at" timestamptz null,
      "finished_at" timestamptz null,
      "created_by" uuid null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "rollout_rollouts_scope_idx" on "rollout_rollouts" ("organization_id", "tenant_id");`)
    this.addSql(`create index "rollout_rollouts_version_idx" on "rollout_rollouts" ("policy_version_id");`)

    this.addSql(`create table "rollout_stages" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "rollout_id" uuid not null,
      "ordinal" int not null,
      "name" text not null,
      "status" text not null default 'pending',
      "min_episodes" int not null,
      "max_intervention_rate" numeric(6,5) not null,
      "max_severe_rate" numeric(6,5) not null,
      "min_success_rate" numeric(6,5) not null,
      "started_at" timestamptz null,
      "finished_at" timestamptz null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "rollout_stages_scope_idx" on "rollout_stages" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "rollout_stages" add constraint "rollout_stages_ordinal_unique" unique ("rollout_id", "ordinal");`)

    this.addSql(`create table "rollout_stage_members" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "stage_id" uuid not null,
      "robot_id" uuid not null,
      "previous_policy_version_id" uuid null,
      "applied_at" timestamptz null,
      "rolled_back_at" timestamptz null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "rollout_members_scope_idx" on "rollout_stage_members" ("organization_id", "tenant_id");`)
    this.addSql(`create index "rollout_members_stage_idx" on "rollout_stage_members" ("stage_id");`)
    this.addSql(`alter table "rollout_stage_members" add constraint "rollout_members_unique" unique ("stage_id", "robot_id");`)

    this.addSql(`create table "rollout_gate_evaluations" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "rollout_id" uuid not null,
      "stage_id" uuid not null,
      "decision" text not null,
      "reason" text not null,
      "episodes" int not null,
      "intervention_rate" numeric(9,6) not null,
      "severe_rate" numeric(9,6) not null,
      "success_rate" numeric(9,6) not null,
      "breached" jsonb null,
      "actor_user_id" uuid null,
      "evaluated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "rollout_gates_scope_idx" on "rollout_gate_evaluations" ("organization_id", "tenant_id");`)
    this.addSql(`create index "rollout_gates_stage_idx" on "rollout_gate_evaluations" ("stage_id", "evaluated_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "rollout_gate_evaluations" cascade;`)
    this.addSql(`drop table if exists "rollout_stage_members" cascade;`)
    this.addSql(`drop table if exists "rollout_stages" cascade;`)
    this.addSql(`drop table if exists "rollout_rollouts" cascade;`)
  }
}

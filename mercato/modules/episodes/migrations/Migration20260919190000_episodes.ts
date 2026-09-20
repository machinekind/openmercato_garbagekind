import { Migration } from '@mikro-orm/migrations'

/**
 * Księga epizodów i interwencji - schemat początkowy.
 *
 * Dwie rzeczy warte przeczytania:
 *
 * 1. **Unikat `(tenant_id, robot_id, external_ref)`.** Agent po utracie łącza
 *    dosyła zaległe epizody i nie może przez to rozmnożyć księgi. Idempotencja
 *    siedzi w bazie, nie w pamięci procesu - ta sama zasada, co przy skrócie
 *    wag w rejestrze polityk i przy pomiarze kalibracyjnym w rejestrze floty.
 *
 * 2. **`episode_id` na interwencji jest nullowalne.** Człowiek, który
 *    przerwał pracę stanowiska między epizodami, też interweniował.
 *    Kolumna `not null` wykluczyłaby te przypadki i zaniżyłaby licznik
 *    przerwań dokładnie w tych wdrożeniach, w których robot stoi najczęściej.
 *
 * Czego tu nie ma: kolumn na trajektorie, obrazy i strumienie. Epizod niesie
 * kilkanaście liczb w `metrics`, a nie zapis przebiegu.
 */
export class Migration20260919190000_episodes extends Migration {
  override name = 'Migration20260919190000_episodes'

  override up(): void | Promise<void> {
    this.addSql(`create table "episodes_episodes" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "cell_id" uuid null,
      "policy_version_id" uuid null,
      "assignment_id" uuid null,
      "sequence" int not null,
      "external_ref" text not null,
      "task_key" text not null,
      "started_at" timestamptz not null,
      "ended_at" timestamptz not null,
      "duration_ms" int not null,
      "outcome" text not null,
      "outcome_detail" text null,
      "intervention_count" int not null default 0,
      "metrics" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "episodes_scope_idx" on "episodes_episodes" ("organization_id", "tenant_id");`)
    this.addSql(`create index "episodes_robot_idx" on "episodes_episodes" ("robot_id", "sequence");`)
    this.addSql(`create index "episodes_policy_idx" on "episodes_episodes" ("policy_version_id", "started_at");`)
    this.addSql(`create index "episodes_cell_idx" on "episodes_episodes" ("cell_id", "started_at");`)
    this.addSql(`alter table "episodes_episodes" add constraint "episodes_external_ref_unique" unique ("tenant_id", "robot_id", "external_ref");`)

    this.addSql(`create table "episodes_interventions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "episode_id" uuid null,
      "robot_id" uuid not null,
      "cell_id" uuid null,
      "policy_version_id" uuid null,
      "kind" text not null,
      "stage" text null,
      "reason_category" text not null,
      "reason" text not null,
      "actor_user_id" uuid null,
      "occurred_at" timestamptz not null,
      "recovery_seconds" int null,
      "notes" text null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "episodes_interventions_scope_idx" on "episodes_interventions" ("organization_id", "tenant_id");`)
    this.addSql(`create index "episodes_interventions_episode_idx" on "episodes_interventions" ("episode_id");`)
    this.addSql(`create index "episodes_interventions_robot_idx" on "episodes_interventions" ("robot_id", "occurred_at");`)
    this.addSql(`create index "episodes_interventions_kind_idx" on "episodes_interventions" ("tenant_id", "kind", "occurred_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "episodes_interventions" cascade;`)
    this.addSql(`drop table if exists "episodes_episodes" cascade;`)
  }
}

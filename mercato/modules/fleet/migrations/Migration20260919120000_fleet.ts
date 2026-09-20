import { Migration } from '@mikro-orm/migrations'

/**
 * Rejestr floty - schemat początkowy.
 *
 * Dwie rzeczy warte uwagi przy czytaniu:
 *
 * 1. `fleet_robots` ma trzy kolumny organizacji, nie jedną. `organization_id`
 *    jest scope'em platformy, a `owner_organization_id` i
 *    `operator_organization_id` niosą realną strukturę własności. Indeksy są
 *    na obu, bo oba są kierunkami zapytań: „pokaż moją flotę" i „pokaż, co
 *    serwisuję".
 *
 * 2. Kalibracja ma unikat na `(robot_id, kind, measured_at)`. To jest klucz
 *    idempotencji: powtórzony import tego samego protokołu pomiarowego odbija
 *    się od bazy, a nie od naszej pamięci - ta sama zasada, co przy księdze
 *    ruchów magazynowych.
 */
export class Migration20260919120000_fleet extends Migration {
  override name = 'Migration20260919120000_fleet'

  override up(): void | Promise<void> {
    this.addSql(`create table "fleet_sites" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "code" text not null,
      "name" text not null,
      "timezone" text not null default 'Europe/Warsaw',
      "address" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_sites_scope_idx" on "fleet_sites" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "fleet_sites" add constraint "fleet_sites_code_unique" unique ("tenant_id", "code");`)

    this.addSql(`create table "fleet_cells" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "site_id" uuid not null,
      "code" text not null,
      "name" text not null,
      "cell_class" text not null,
      "risk_class" text not null default 'fenced',
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_cells_scope_idx" on "fleet_cells" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "fleet_cells" add constraint "fleet_cells_code_unique" unique ("tenant_id", "site_id", "code");`)

    this.addSql(`create table "fleet_embodiment_revisions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "embodiment_key" text not null,
      "revision" int not null,
      "name" text not null,
      "spec_digest" text not null,
      "dof_count" int null,
      "spec" jsonb null,
      "required_calibrations" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_embodiments_scope_idx" on "fleet_embodiment_revisions" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "fleet_embodiment_revisions" add constraint "fleet_embodiments_key_revision_unique" unique ("tenant_id", "embodiment_key", "revision");`)

    this.addSql(`create table "fleet_robots" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "owner_organization_id" uuid not null,
      "operator_organization_id" uuid not null,
      "serial_number" text not null,
      "name" text not null,
      "embodiment_revision_id" uuid not null,
      "cell_id" uuid null,
      "state" text not null default 'registered',
      "state_reason" text null,
      "state_changed_at" timestamptz null,
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_robots_scope_idx" on "fleet_robots" ("organization_id", "tenant_id");`)
    this.addSql(`create index "fleet_robots_owner_idx" on "fleet_robots" ("owner_organization_id", "tenant_id");`)
    this.addSql(`create index "fleet_robots_operator_idx" on "fleet_robots" ("operator_organization_id", "tenant_id");`)
    this.addSql(`create index "fleet_robots_state_idx" on "fleet_robots" ("tenant_id", "state");`)
    this.addSql(`alter table "fleet_robots" add constraint "fleet_robots_serial_unique" unique ("tenant_id", "serial_number");`)

    this.addSql(`create table "fleet_calibrations" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "kind" text not null,
      "measured_at" timestamptz not null,
      "valid_until" timestamptz not null,
      "uncertainty" jsonb null,
      "values" jsonb null,
      "measured_by" uuid null,
      "invalidated_at" timestamptz null,
      "invalidated_reason" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_calibrations_scope_idx" on "fleet_calibrations" ("organization_id", "tenant_id");`)
    this.addSql(`create index "fleet_calibrations_robot_idx" on "fleet_calibrations" ("robot_id", "kind", "measured_at");`)
    this.addSql(`alter table "fleet_calibrations" add constraint "fleet_calibrations_measurement_unique" unique ("robot_id", "kind", "measured_at");`)

    this.addSql(`create table "fleet_robot_transitions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "from_state" text null,
      "to_state" text not null,
      "reason" text not null,
      "actor_user_id" uuid null,
      "occurred_at" timestamptz not null,
      "metadata" jsonb null,
      primary key ("id"));`)
    this.addSql(`create index "fleet_transitions_scope_idx" on "fleet_robot_transitions" ("organization_id", "tenant_id");`)
    this.addSql(`create index "fleet_transitions_robot_idx" on "fleet_robot_transitions" ("robot_id", "occurred_at");`)

    this.addSql(`alter table "fleet_cells" add constraint "fleet_cells_site_id_foreign" foreign key ("site_id") references "fleet_sites" ("id");`)
    this.addSql(`alter table "fleet_robots" add constraint "fleet_robots_embodiment_foreign" foreign key ("embodiment_revision_id") references "fleet_embodiment_revisions" ("id");`)
    this.addSql(`alter table "fleet_robots" add constraint "fleet_robots_cell_foreign" foreign key ("cell_id") references "fleet_cells" ("id");`)
    this.addSql(`alter table "fleet_calibrations" add constraint "fleet_calibrations_robot_foreign" foreign key ("robot_id") references "fleet_robots" ("id");`)
    this.addSql(`alter table "fleet_robot_transitions" add constraint "fleet_transitions_robot_foreign" foreign key ("robot_id") references "fleet_robots" ("id");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "fleet_robot_transitions" cascade;`)
    this.addSql(`drop table if exists "fleet_calibrations" cascade;`)
    this.addSql(`drop table if exists "fleet_robots" cascade;`)
    this.addSql(`drop table if exists "fleet_embodiment_revisions" cascade;`)
    this.addSql(`drop table if exists "fleet_cells" cascade;`)
    this.addSql(`drop table if exists "fleet_sites" cascade;`)
  }
}

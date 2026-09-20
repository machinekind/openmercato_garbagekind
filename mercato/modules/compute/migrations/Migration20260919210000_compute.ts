import { Migration } from '@mikro-orm/migrations'

/**
 * Węzły obliczeniowe - schemat początkowy.
 *
 * Dwa ograniczenia w bazie warte uwagi: zamknięty słownik ról (bez
 * `safety_function`) i obowiązkowa precyzja przy mocy obliczeniowej.
 * Reguła w kodzie chroni przed pomyłką, ograniczenie w bazie przed
 * obejściem kodu.
 */
export class Migration20260919210000_compute extends Migration {
  override name = 'Migration20260919210000_compute'

  override up(): void | Promise<void> {
    this.addSql(`create table "compute_nodes" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "code" text not null,
      "name" text not null,
      "kind" text not null,
      "cell_id" uuid null,
      "memory_gb" int not null,
      "memory_bandwidth_gbs" int not null,
      "compute_tflops" double precision not null,
      "compute_precision" text not null,
      "roles" jsonb not null,
      "shared_general_purpose" boolean not null default true,
      "realtime_capable" boolean not null default false,
      "status" text not null default 'active',
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "compute_nodes_scope_idx" on "compute_nodes" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "compute_nodes" add constraint "compute_nodes_code_unique" unique ("tenant_id", "code");`)
    this.addSql(`alter table "compute_nodes" add constraint "compute_nodes_precision_chk" check ("compute_precision" in ('fp4','fp8','int8','fp16','bf16','fp32'));`)
    // Zamknięty słownik ról egzekwowany przez bazę. `safety_function` nie da
    // się tu wpisać nawet z pominięciem komendy.
    this.addSql(`alter table "compute_nodes" add constraint "compute_nodes_roles_chk" check (
      "roles" <@ '["training","evaluation","vision_inference","policy_inference","simulation","data_processing"]'::jsonb);`)

    this.addSql(`create table "compute_placements" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "node_id" uuid not null,
      "workload_type" text not null,
      "workload_ref" uuid not null,
      "toolchain" jsonb null,
      "started_at" timestamptz not null,
      "ended_at" timestamptz null,
      "notes" text null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "compute_placements_scope_idx" on "compute_placements" ("organization_id", "tenant_id");`)
    this.addSql(`create index "compute_placements_node_idx" on "compute_placements" ("node_id", "started_at");`)
    this.addSql(`create index "compute_placements_workload_idx" on "compute_placements" ("tenant_id", "workload_type", "workload_ref");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "compute_placements" cascade;`)
    this.addSql(`drop table if exists "compute_nodes" cascade;`)
  }
}

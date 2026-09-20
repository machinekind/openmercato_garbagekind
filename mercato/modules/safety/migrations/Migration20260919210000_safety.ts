import { Migration } from '@mikro-orm/migrations'

/**
 * Bezpieczeństwo i zgodność - schemat początkowy.
 *
 * Trzy rzeczy warte przeczytania:
 *
 * 1. **`safety_cases.cell_class` jest tekstem, nie kluczem obcym do
 *    `fleet_cells`.** Klucz obcy byłby tu naturalny i byłby błędem:
 *    dopuszczenie dotyczy klasy celi, więc każda nowa cela o tej samej,
 *    niezmienionej konfiguracji wymagałaby osobnego uzasadnienia. To jest
 *    koszt, którego nikt nie poniesie, i który w praktyce kończy się
 *    dopuszczeniami udzielanymi hurtem bez czytania.
 *
 * 2. **`declared_as_safety_function` istnieje po to, żeby było fałszem.**
 *    Uczona polityka w łańcuchu bezpieczeństwa wpycha maszynę w Annex I
 *    część A rozporządzenia 2023/1230. Kolumna zmusza do jawnego zapisania
 *    tej decyzji, a komenda zatwierdzenia jej odmawia.
 *
 * 3. **Przebiegi ewaluacyjne są dopisywane, nie nadpisywane**, i niosą odcisk
 *    kontraktu embodimentu. Zestaw zaliczony na innym sprzęcie nie dowodzi
 *    niczego o tym sprzęcie.
 */
export class Migration20260919210000_safety extends Migration {
  override name = 'Migration20260919210000_safety'

  override up(): void | Promise<void> {
    this.addSql(`create table "safety_cases" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_version_id" uuid not null,
      "cell_class" text not null,
      "risk_class" text not null,
      "status" text not null default 'draft',
      "declared_as_safety_function" boolean not null default false,
      "hazards" jsonb null,
      "standards" jsonb null,
      "safety_layer" text null,
      "approved_by" uuid null,
      "approved_at" timestamptz null,
      "valid_until" timestamptz null,
      "withdrawn_reason" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "safety_cases_scope_idx" on "safety_cases" ("organization_id", "tenant_id");`)
    this.addSql(`create index "safety_cases_class_idx" on "safety_cases" ("tenant_id", "cell_class", "status");`)
    this.addSql(`alter table "safety_cases" add constraint "safety_cases_version_class_unique" unique ("tenant_id", "policy_version_id", "cell_class");`)

    this.addSql(`create table "safety_eval_suites" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "suite_key" text not null,
      "name" text not null,
      "description" text null,
      "required_for" jsonb not null,
      "case_count" int null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "safety_suites_scope_idx" on "safety_eval_suites" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "safety_eval_suites" add constraint "safety_suites_key_unique" unique ("tenant_id", "suite_key");`)

    this.addSql(`create table "safety_eval_runs" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_version_id" uuid not null,
      "suite_key" text not null,
      "result" text not null,
      "passed_cases" int null,
      "total_cases" int null,
      "embodiment_spec_digest" text null,
      "evidence_uri" text null,
      "ran_at" timestamptz not null,
      "ran_by" uuid null,
      "details" jsonb null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "safety_runs_scope_idx" on "safety_eval_runs" ("organization_id", "tenant_id");`)
    this.addSql(`create index "safety_runs_version_idx" on "safety_eval_runs" ("policy_version_id", "suite_key", "ran_at");`)

    this.addSql(`create table "safety_incidents" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid null,
      "cell_id" uuid null,
      "cell_class" text null,
      "policy_version_id" uuid null,
      "episode_id" uuid null,
      "harm" text not null,
      "safety_layer_engaged" boolean not null default false,
      "policy_implicated" boolean not null default false,
      "priority" text not null,
      "halt_deployment" boolean not null default false,
      "description" text not null,
      "occurred_at" timestamptz not null,
      "reported_by" uuid null,
      "reported_to_authority_at" timestamptz null,
      "root_cause" text null,
      "closed_at" timestamptz null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "safety_incidents_scope_idx" on "safety_incidents" ("organization_id", "tenant_id");`)
    this.addSql(`create index "safety_incidents_robot_idx" on "safety_incidents" ("robot_id", "occurred_at");`)
    this.addSql(`create index "safety_incidents_version_idx" on "safety_incidents" ("policy_version_id", "occurred_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "safety_incidents" cascade;`)
    this.addSql(`drop table if exists "safety_eval_runs" cascade;`)
    this.addSql(`drop table if exists "safety_eval_suites" cascade;`)
    this.addSql(`drop table if exists "safety_cases" cascade;`)
  }
}

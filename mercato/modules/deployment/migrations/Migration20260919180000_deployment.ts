import { Migration } from '@mikro-orm/migrations'

/**
 * Kanał stanu pożądanego - schemat początkowy.
 *
 * Dwie rzeczy warte przeczytania:
 *
 * 1. **Indeks częściowy `deployment_assignments_active_unique`.** Robot ma
 *    najwyżej jedno czynne przypisanie i egzekwuje to baza, nie pamięć
 *    komendy. Dwaj inżynierowie przypisujący dwie polityki temu samemu ramieniu
 *    w tej samej minucie to nie jest przypadek teoretyczny. `where superseded_at
 *    is null and revoked_at is null` zostawia całą historię nietkniętą -
 *    unikat pełny wymuszałby kasowanie, a kasowanie zabiera odpowiedź na
 *    pytanie „co ta maszyna robiła w zeszły wtorek".
 *
 * 2. **Unikat `(agent_session_id, sequence)` na dzierżawach.** Ochrona przed
 *    powtórką żądania jest w bazie z tego samego powodu, co deduplikacja wag
 *    w rejestrze polityk: dwa procesy nie umawiają się ze sobą przez pamięć
 *    jednego z nich.
 */
export class Migration20260919180000_deployment extends Migration {
  override name = 'Migration20260919180000_deployment'

  override up(): void | Promise<void> {
    this.addSql(`create table "deployment_assignments" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "policy_version_id" uuid not null,
      "policy_content_digest" text not null,
      "cell_id" uuid null,
      "risk_class" text not null,
      "lease_seconds" int not null,
      "desired_state" text not null default 'running',
      "reason" text not null,
      "assigned_by" uuid null,
      "assigned_at" timestamptz not null,
      "superseded_at" timestamptz null,
      "revoked_at" timestamptz null,
      "revoked_reason" text null,
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "deployment_assignments_scope_idx" on "deployment_assignments" ("organization_id", "tenant_id");`)
    this.addSql(`create index "deployment_assignments_robot_idx" on "deployment_assignments" ("robot_id", "assigned_at");`)
    this.addSql(`create index "deployment_assignments_version_idx" on "deployment_assignments" ("policy_version_id");`)
    this.addSql(`create unique index "deployment_assignments_active_unique" on "deployment_assignments" ("tenant_id", "robot_id")
      where "superseded_at" is null and "revoked_at" is null;`)

    this.addSql(`create table "deployment_leases" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "assignment_id" uuid not null,
      "robot_id" uuid not null,
      "agent_session_id" uuid not null,
      "sequence" int not null,
      "issued_at" timestamptz not null,
      "expires_at" timestamptz not null,
      "lease_seconds" int not null,
      "revoked_at" timestamptz null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "deployment_leases_scope_idx" on "deployment_leases" ("organization_id", "tenant_id");`)
    this.addSql(`create index "deployment_leases_robot_idx" on "deployment_leases" ("robot_id", "issued_at");`)
    this.addSql(`create index "deployment_leases_assignment_idx" on "deployment_leases" ("assignment_id", "issued_at");`)
    this.addSql(`alter table "deployment_leases" add constraint "deployment_leases_sequence_unique" unique ("agent_session_id", "sequence");`)

    this.addSql(`create table "deployment_state_reports" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "assignment_id" uuid null,
      "reported_policy_version_id" uuid null,
      "reported_state" text not null,
      "reconciliation" text not null,
      "reason" text not null,
      "reported_at" timestamptz not null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "deployment_reports_scope_idx" on "deployment_state_reports" ("organization_id", "tenant_id");`)
    this.addSql(`create index "deployment_reports_robot_idx" on "deployment_state_reports" ("robot_id", "reported_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "deployment_state_reports" cascade;`)
    this.addSql(`drop table if exists "deployment_leases" cascade;`)
    this.addSql(`drop table if exists "deployment_assignments" cascade;`)
  }
}

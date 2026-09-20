import { Migration } from '@mikro-orm/migrations'

/**
 * Rejestr polityk - schemat początkowy.
 *
 * Trzy unikaty niosą całą treść fazy i warto je przeczytać razem:
 *
 * 1. `(tenant_id, policy_id, content_digest)` - drugie wgranie tych samych wag
 *    odbija się od **bazy**, nie od naszej pamięci. Gdyby deduplikacja żyła
 *    wyłącznie w kodzie komendy, dwa równoległe potoki CI wgrałyby ten sam
 *    model dwa razy i nikt by tego nie zauważył.
 * 2. `(tenant_id, policy_id, version)` - numer jest etykietą i ma być gęsty.
 * 3. `(policy_version_id, role)` - komplet ma jedne wagi. Dwa pliki w tej samej
 *    roli uzależniłyby skrót treści od kolejności wgrywania.
 *
 * Czego tu nie ma: kolumny na bajty. Artefakt jest adresem i skrótem.
 */
export class Migration20260919170000_policy_registry extends Migration {
  override name = 'Migration20260919170000_policy_registry'

  override up(): void | Promise<void> {
    this.addSql(`create table "policy_registry_policies" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_key" text not null,
      "name" text not null,
      "embodiment_key" text not null,
      "task_key" text not null,
      "learning_method" text not null default 'rl',
      "description" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "policy_registry_policies_scope_idx" on "policy_registry_policies" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "policy_registry_policies" add constraint "policy_registry_policies_key_unique" unique ("tenant_id", "policy_key");`)

    this.addSql(`create table "policy_registry_policy_versions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_id" uuid not null,
      "version" int not null,
      "content_digest" text not null,
      "embodiment_revision_id" uuid not null,
      "embodiment_spec_digest" text not null,
      "status" text not null default 'registered',
      "status_reason" text null,
      "status_changed_at" timestamptz null,
      "provenance" jsonb null,
      "observation_dim" int null,
      "action_dim" int null,
      "registered_by" uuid null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "policy_registry_versions_scope_idx" on "policy_registry_policy_versions" ("organization_id", "tenant_id");`)
    this.addSql(`create index "policy_registry_versions_policy_idx" on "policy_registry_policy_versions" ("policy_id", "version");`)
    this.addSql(`create index "policy_registry_versions_embodiment_idx" on "policy_registry_policy_versions" ("embodiment_revision_id");`)
    this.addSql(`alter table "policy_registry_policy_versions" add constraint "policy_registry_versions_digest_unique" unique ("tenant_id", "policy_id", "content_digest");`)
    this.addSql(`alter table "policy_registry_policy_versions" add constraint "policy_registry_versions_number_unique" unique ("tenant_id", "policy_id", "version");`)

    this.addSql(`create table "policy_registry_artifacts" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_version_id" uuid not null,
      "role" text not null,
      "digest" text not null,
      "size_bytes" bigint null,
      "media_type" text null,
      "uri" text not null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "policy_registry_artifacts_scope_idx" on "policy_registry_artifacts" ("organization_id", "tenant_id");`)
    this.addSql(`create index "policy_registry_artifacts_version_idx" on "policy_registry_artifacts" ("policy_version_id");`)
    this.addSql(`alter table "policy_registry_artifacts" add constraint "policy_registry_artifacts_role_unique" unique ("policy_version_id", "role");`)

    this.addSql(`create table "policy_registry_version_events" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "policy_version_id" uuid not null,
      "from_status" text null,
      "to_status" text not null,
      "reason" text not null,
      "actor_user_id" uuid null,
      "occurred_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "policy_registry_events_scope_idx" on "policy_registry_version_events" ("organization_id", "tenant_id");`)
    this.addSql(`create index "policy_registry_events_version_idx" on "policy_registry_version_events" ("policy_version_id", "occurred_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "policy_registry_version_events" cascade;`)
    this.addSql(`drop table if exists "policy_registry_artifacts" cascade;`)
    this.addSql(`drop table if exists "policy_registry_policy_versions" cascade;`)
    this.addSql(`drop table if exists "policy_registry_policies" cascade;`)
  }
}

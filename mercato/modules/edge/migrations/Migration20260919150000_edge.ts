import { Migration } from '@mikro-orm/migrations'

/**
 * Kanał brzegowy - schemat początkowy.
 *
 * Trzy rzeczy warte uwagi przy czytaniu:
 *
 * 1. W `edge_enrollment_tokens` nie ma kolumny z jawnym biletem i nigdy nie ma
 *    jej przybyć. Unikat jest na skrócie, bo to on jest wyszukiwany.
 *
 * 2. `edge_agent_keys` ma unikat na odcisku w obrębie tenanta. Ten sam klucz
 *    publiczny podstawiony dla dwóch agentów byłby albo pomyłką wdrożeniową,
 *    albo próbą klonowania tożsamości - w obu przypadkach ma się odbić od bazy.
 *
 * 3. Indeks `edge_sessions_open_idx` na `(tenant_id, ended_at)` obsługuje
 *    jedyne zapytanie, które biegnie cyklicznie: „pokaż otwarte sesje".
 *    Przy tysiącu robotów bijących co 30 s to różnica rzędu wielkości.
 */
export class Migration20260919150000_edge extends Migration {
  override name = 'Migration20260919150000_edge'

  override up(): void | Promise<void> {
    this.addSql(`create table "edge_enrollment_tokens" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "token_hash" text not null,
      "expires_at" timestamptz not null,
      "used_at" timestamptz null,
      "used_by_agent_id" uuid null,
      "issued_by" uuid null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "edge_tokens_scope_idx" on "edge_enrollment_tokens" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "edge_enrollment_tokens" add constraint "edge_tokens_hash_unique" unique ("token_hash");`)

    this.addSql(`create table "edge_agents" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "robot_id" uuid not null,
      "agent_kind" text not null default 'onboard',
      "agent_version" text null,
      "status" text not null default 'enrolled',
      "heartbeat_interval_seconds" int not null default 30,
      "liveness_grace_seconds" int not null default 30,
      "lost_after_seconds" int not null default 300,
      "last_seen_at" timestamptz null,
      "enrolled_at" timestamptz not null,
      "revoked_at" timestamptz null,
      "revoked_reason" text null,
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "edge_agents_scope_idx" on "edge_agents" ("organization_id", "tenant_id");`)
    this.addSql(`create index "edge_agents_robot_idx" on "edge_agents" ("tenant_id", "robot_id");`)
    // Jeden ważny agent na robota. Warunek częściowy, bo agenci odwołani
    // zostają w tabeli na zawsze - historia tożsamości jest materiałem audytowym.
    this.addSql(`create unique index "edge_agents_active_robot_unique" on "edge_agents" ("tenant_id", "robot_id") where "status" = 'enrolled';`)

    this.addSql(`create table "edge_agent_keys" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "agent_id" uuid not null,
      "public_key" text not null,
      "algorithm" text not null default 'ed25519',
      "fingerprint" text not null,
      "active_from" timestamptz not null,
      "active_until" timestamptz null,
      "revoked_at" timestamptz null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "edge_keys_scope_idx" on "edge_agent_keys" ("organization_id", "tenant_id");`)
    this.addSql(`create index "edge_keys_agent_idx" on "edge_agent_keys" ("agent_id", "active_from");`)
    this.addSql(`alter table "edge_agent_keys" add constraint "edge_keys_fingerprint_unique" unique ("tenant_id", "fingerprint");`)

    this.addSql(`create table "edge_agent_sessions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "agent_id" uuid not null,
      "key_id" uuid not null,
      "agent_version" text null,
      "started_at" timestamptz not null,
      "last_heartbeat_at" timestamptz null,
      "last_sequence" int not null default 0,
      "heartbeat_count" int not null default 0,
      "ended_at" timestamptz null,
      "ended_reason" text null,
      primary key ("id"));`)
    this.addSql(`create index "edge_sessions_scope_idx" on "edge_agent_sessions" ("organization_id", "tenant_id");`)
    this.addSql(`create index "edge_sessions_agent_idx" on "edge_agent_sessions" ("agent_id", "started_at");`)
    this.addSql(`create index "edge_sessions_open_idx" on "edge_agent_sessions" ("tenant_id", "ended_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "edge_agent_sessions" cascade;`)
    this.addSql(`drop table if exists "edge_agent_keys" cascade;`)
    this.addSql(`drop table if exists "edge_agents" cascade;`)
    this.addSql(`drop table if exists "edge_enrollment_tokens" cascade;`)
  }
}

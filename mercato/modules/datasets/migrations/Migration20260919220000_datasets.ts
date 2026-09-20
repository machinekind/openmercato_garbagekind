import { Migration } from '@mikro-orm/migrations'

/**
 * Zbiory danych - schemat początkowy.
 *
 * Trzy rzeczy warte przeczytania:
 *
 * 1. **Unikat `(tenant_id, dataset_id, content_digest)`.** Tożsamością wersji
 *    zbioru jest jego zawartość, nie moment zbudowania. Przebudowanie z tych
 *    samych kryteriów nad niezmienioną księgą daje tę samą wersję, a nie
 *    kolejną - inaczej zdanie „polityka v7 uczyła się na zbiorze X w wersji 3"
 *    nie miałoby stabilnego odniesienia.
 *
 * 2. **`datasets_members` trzyma odniesienia, nie kopie danych.** Identyfikator
 *    epizodu i rola. Bajty przebiegów leżą w magazynie obiektów i nie
 *    przechodzą przez MikroORM.
 *
 * 3. **`datasets_training_runs` to osobna tabela, a nie kolumna na wersji
 *    polityki.** Z jednego zbioru wychodzi kilka polityk, a jedna polityka
 *    bywa dostrajana kolejno na dwóch zbiorach. Kolumna nie uniesie żadnego
 *    z tych przypadków, a oba są normą.
 */
export class Migration20260919220000_datasets extends Migration {
  override name = 'Migration20260919220000_datasets'

  override up(): void | Promise<void> {
    this.addSql(`create table "datasets_datasets" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "dataset_key" text not null,
      "name" text not null,
      "task_key" text not null,
      "embodiment_key" text not null,
      "description" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "datasets_scope_idx" on "datasets_datasets" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "datasets_datasets" add constraint "datasets_key_unique" unique ("tenant_id", "dataset_key");`)

    this.addSql(`create table "datasets_versions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "dataset_id" uuid not null,
      "version" int not null,
      "content_digest" text not null,
      "episode_count" int not null,
      "demo_count" int not null default 0,
      "correction_count" int not null default 0,
      "failure_count" int not null default 0,
      "holdout_count" int not null default 0,
      "warnings" jsonb null,
      "criteria" jsonb null,
      "export_uri" text null,
      "built_by" uuid null,
      "built_at" timestamptz not null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "datasets_versions_scope_idx" on "datasets_versions" ("organization_id", "tenant_id");`)
    this.addSql(`create index "datasets_versions_dataset_idx" on "datasets_versions" ("dataset_id", "version");`)
    this.addSql(`alter table "datasets_versions" add constraint "datasets_versions_digest_unique" unique ("tenant_id", "dataset_id", "content_digest");`)
    this.addSql(`alter table "datasets_versions" add constraint "datasets_versions_number_unique" unique ("tenant_id", "dataset_id", "version");`)

    this.addSql(`create table "datasets_members" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "dataset_version_id" uuid not null,
      "episode_id" uuid not null,
      "role" text not null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "datasets_members_scope_idx" on "datasets_members" ("organization_id", "tenant_id");`)
    this.addSql(`create index "datasets_members_version_idx" on "datasets_members" ("dataset_version_id", "role");`)
    // Indeks po epizodzie jest tym, co czyni pętlę dwukierunkową: bez niego
    // pytanie „w których zbiorach jest ten epizod" wymaga przejścia całej tabeli.
    this.addSql(`create index "datasets_members_episode_idx" on "datasets_members" ("episode_id");`)
    this.addSql(`alter table "datasets_members" add constraint "datasets_members_unique" unique ("dataset_version_id", "episode_id");`)

    this.addSql(`create table "datasets_training_runs" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "dataset_version_id" uuid not null,
      "policy_version_id" uuid null,
      "run_ref" text not null,
      "framework" text null,
      "hyperparameters" jsonb null,
      "status" text not null default 'running',
      "started_at" timestamptz not null,
      "finished_at" timestamptz null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "datasets_runs_scope_idx" on "datasets_training_runs" ("organization_id", "tenant_id");`)
    this.addSql(`create index "datasets_runs_version_idx" on "datasets_training_runs" ("dataset_version_id");`)
    this.addSql(`create index "datasets_runs_policy_idx" on "datasets_training_runs" ("policy_version_id");`)
    this.addSql(`alter table "datasets_training_runs" add constraint "datasets_runs_ref_unique" unique ("tenant_id", "run_ref");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "datasets_training_runs" cascade;`)
    this.addSql(`drop table if exists "datasets_members" cascade;`)
    this.addSql(`drop table if exists "datasets_versions" cascade;`)
    this.addSql(`drop table if exists "datasets_datasets" cascade;`)
  }
}

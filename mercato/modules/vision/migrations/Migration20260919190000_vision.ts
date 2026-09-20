import { Migration } from '@mikro-orm/migrations'

/**
 * Wzrok maszynowy - schemat początkowy.
 *
 * Czego tu **nie ma** i nie ma przybyć: kolumny z bajtami wideo. Klip jest
 * adresem i terminem usunięcia. Art. 22² § 3 Kodeksu pracy nakazuje zniszczenie
 * nagrań po trzech miesiącach, a baza ERP jest najgorszym możliwym miejscem
 * na materiał objęty takim terminem.
 *
 * Indeks `vision_clips_purge_idx` obsługuje jedyne zapytanie biegnące
 * cyklicznie: „co jest po terminie i nie jest wstrzymane".
 */
export class Migration20260919190000_vision extends Migration {
  override name = 'Migration20260919190000_vision'

  override up(): void | Promise<void> {
    this.addSql(`create table "vision_cameras" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "cell_id" uuid not null,
      "code" text not null,
      "name" text not null,
      "view_role" text not null,
      "purpose" text not null,
      "retention_days" int not null,
      "people_in_view" boolean not null default true,
      "workforce_notified_at" timestamptz null,
      "area_marked_at" timestamptz null,
      "resolution" text null,
      "frames_per_second" int null,
      "status" text not null default 'active',
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "vision_cameras_scope_idx" on "vision_cameras" ("organization_id", "tenant_id");`)
    this.addSql(`create index "vision_cameras_cell_idx" on "vision_cameras" ("tenant_id", "cell_id");`)
    this.addSql(`alter table "vision_cameras" add constraint "vision_cameras_code_unique" unique ("tenant_id", "code");`)
    // Ustawowy limit trzech miesięcy egzekwowany także przez bazę: reguła
    // w kodzie chroni przed pomyłką, ograniczenie w bazie przed obejściem kodu.
    this.addSql(`alter table "vision_cameras" add constraint "vision_cameras_retention_chk" check ("retention_days" between 1 and 90);`)
    this.addSql(`alter table "vision_cameras" add constraint "vision_cameras_purpose_chk" check ("purpose" in ('safety','property','production_control','trade_secret'));`)

    this.addSql(`create table "vision_detector_versions" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "detector_key" text not null,
      "revision" int not null,
      "name" text not null,
      "weights_digest" text not null,
      "class_vocabulary" jsonb not null,
      "confidence_threshold" double precision not null,
      "input_resolution" text null,
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "vision_detectors_scope_idx" on "vision_detector_versions" ("organization_id", "tenant_id");`)
    this.addSql(`alter table "vision_detector_versions" add constraint "vision_detectors_key_revision_unique" unique ("tenant_id", "detector_key", "revision");`)
    this.addSql(`alter table "vision_detector_versions" add constraint "vision_detectors_threshold_chk" check ("confidence_threshold" > 0 and "confidence_threshold" <= 1);`)

    this.addSql(`create table "vision_detection_windows" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "camera_id" uuid not null,
      "cell_id" uuid not null,
      "detector_version_id" uuid not null,
      "started_at" timestamptz not null,
      "ended_at" timestamptz not null,
      "frames_analyzed" int not null,
      "counting_mode" text not null,
      "counts" jsonb not null,
      "mean_confidence" jsonb null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "vision_windows_scope_idx" on "vision_detection_windows" ("organization_id", "tenant_id");`)
    this.addSql(`create index "vision_windows_camera_idx" on "vision_detection_windows" ("camera_id", "started_at");`)
    this.addSql(`create index "vision_windows_cell_idx" on "vision_detection_windows" ("tenant_id", "cell_id", "started_at");`)
    this.addSql(`alter table "vision_detection_windows" add constraint "vision_windows_unique" unique ("camera_id", "started_at", "detector_version_id");`)
    this.addSql(`alter table "vision_detection_windows" add constraint "vision_windows_mode_chk" check ("counting_mode" in ('tracks','detections'));`)

    this.addSql(`create table "vision_clips" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "camera_id" uuid not null,
      "subject_type" text not null,
      "subject_id" uuid null,
      "uri" text not null,
      "recorded_at" timestamptz not null,
      "duration_seconds" int not null,
      "delete_after" timestamptz not null,
      "purged_at" timestamptz null,
      "legal_hold_reference" text null,
      "created_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "vision_clips_scope_idx" on "vision_clips" ("organization_id", "tenant_id");`)
    this.addSql(`create index "vision_clips_purge_idx" on "vision_clips" ("tenant_id", "delete_after", "purged_at");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "vision_clips" cascade;`)
    this.addSql(`drop table if exists "vision_detection_windows" cascade;`)
    this.addSql(`drop table if exists "vision_detector_versions" cascade;`)
    this.addSql(`drop table if exists "vision_cameras" cascade;`)
  }
}

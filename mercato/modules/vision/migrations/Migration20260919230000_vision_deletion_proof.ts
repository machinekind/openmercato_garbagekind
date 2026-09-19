import { Migration } from '@mikro-orm/migrations'

/**
 * Rozdzielenie „oznaczone do usunięcia" od „potwierdzono usunięcie".
 *
 * Kolumna nazywała się `purged_at` i sugerowała, że plik zniknął. Platforma
 * nigdy go nie kasuje — bajty leżą w magazynie obiektów, do którego ERP nie
 * ma dostępu, i tak ma zostać. Dopóki jednak jedynym śladem było „purged",
 * zautomatyzowanie oznaczania dałoby **zautomatyzowaną księgowość zamiast
 * zgodności**, a nikt by tego nie zauważył.
 *
 * Po zmianie system umie odpowiedzieć na właściwe pytanie: ile nagrań jest
 * po ustawowym terminie, oznaczonych, i **nadal istnieje**.
 */
export class Migration20260919230000_vision_deletion_proof extends Migration {
  override name = 'Migration20260919230000_vision_deletion_proof'

  override up(): void | Promise<void> {
    this.addSql(`alter table "vision_clips" rename column "purged_at" to "marked_for_deletion_at";`)
    this.addSql(`alter table "vision_clips" add column "deletion_confirmed_at" timestamptz null;`)
    this.addSql(`alter table "vision_clips" add column "deletion_confirmed_by" text null;`)
    // Potwierdzenie bez oznaczenia znaczy, że ktoś skasował materiał przed
    // terminem i poza procesem — baza ma to odbić, a nie przyjąć.
    this.addSql(`alter table "vision_clips" add constraint "vision_clips_deletion_order_chk" check (
      "deletion_confirmed_at" is null or "marked_for_deletion_at" is not null);`)
    this.addSql(`drop index if exists "vision_clips_purge_idx";`)
    this.addSql(`create index "vision_clips_purge_idx" on "vision_clips" ("tenant_id", "delete_after", "marked_for_deletion_at");`)
    this.addSql(`create index "vision_clips_unconfirmed_idx" on "vision_clips" ("tenant_id", "deletion_confirmed_at") where "marked_for_deletion_at" is not null;`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index if exists "vision_clips_unconfirmed_idx";`)
    this.addSql(`alter table "vision_clips" drop constraint if exists "vision_clips_deletion_order_chk";`)
    this.addSql(`alter table "vision_clips" drop column if exists "deletion_confirmed_by";`)
    this.addSql(`alter table "vision_clips" drop column if exists "deletion_confirmed_at";`)
    this.addSql(`alter table "vision_clips" rename column "marked_for_deletion_at" to "purged_at";`)
  }
}

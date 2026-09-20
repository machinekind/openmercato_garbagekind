import { Migration } from '@mikro-orm/migrations'

/**
 * Most hala ↔ przedsiębiorstwo - schemat początkowy.
 *
 * Trzy rzeczy warte uwagi przy czytaniu:
 *
 * 1. Masy są w **gramach jako `bigint`**, nie w kilogramach zmiennoprzecinkowych.
 *    Bilans masy w sortowni pokazał już raz, że suma stu wartości po 3803,73
 *    zależy od kolejności sumowania. Przeliczenie na kilogramy dzieje się
 *    na granicy - przy komendzie magazynowej i na ekranie.
 *
 * 2. `work_orders_reconciliations` nie ma unikatu na partię. To celowe:
 *    ponowne ważenie tworzy kolejny wpis, a nie zmienia poprzedniego.
 *
 * 3. Indeks częściowy na otwartej partii wymusza jedną naraz na zlecenie.
 *    Epizody wiąże z partią okno czasowe, więc dwie otwarte partie
 *    przypisałyby ten sam chwyt do dwóch pojemników - i baza ma to odbić,
 *    a nie nasza pamięć.
 */
export class Migration20260919170000_work_orders extends Migration {
  override name = 'Migration20260919170000_work_orders'

  override up(): void | Promise<void> {
    this.addSql(`create table "work_orders_orders" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "order_number" text not null,
      "cell_id" uuid not null,
      "policy_version_id" uuid null,
      "catalog_variant_id" uuid not null,
      "sku" text not null,
      "warehouse_id" uuid not null,
      "location_id" uuid not null,
      "target_grams" bigint not null,
      "nominal_piece_grams" int null,
      "sales_order_id" uuid null,
      "status" text not null default 'open',
      "opened_at" timestamptz not null,
      "closed_at" timestamptz null,
      "opened_by" uuid null,
      "notes" text null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      "deleted_at" timestamptz null,
      primary key ("id"));`)
    this.addSql(`create index "work_orders_scope_idx" on "work_orders_orders" ("organization_id", "tenant_id");`)
    this.addSql(`create index "work_orders_cell_idx" on "work_orders_orders" ("tenant_id", "cell_id", "status");`)
    this.addSql(`alter table "work_orders_orders" add constraint "work_orders_number_unique" unique ("tenant_id", "order_number");`)

    this.addSql(`create table "work_orders_batches" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "work_order_id" uuid not null,
      "container_code" text not null,
      "opened_at" timestamptz not null,
      "closed_at" timestamptz null,
      "weighed_grams" bigint null,
      "claimed_pieces" int null,
      "lot_id" uuid null,
      "lot_number" text null,
      "status" text not null default 'filling',
      "discarded_reason" text null,
      "metadata" jsonb null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "work_batches_scope_idx" on "work_orders_batches" ("organization_id", "tenant_id");`)
    this.addSql(`create index "work_batches_order_idx" on "work_orders_batches" ("work_order_id", "opened_at");`)
    this.addSql(`alter table "work_orders_batches" add constraint "work_batches_container_unique" unique ("tenant_id", "container_code", "opened_at");`)
    this.addSql(`create unique index "work_batches_single_open_idx" on "work_orders_batches" ("work_order_id") where "status" = 'filling';`)

    this.addSql(`create table "work_orders_reconciliations" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "batch_id" uuid not null,
      "policy_version_id" uuid null,
      "claimed_pieces" int not null,
      "nominal_piece_grams" int null,
      "expected_grams" bigint null,
      "weighed_grams" bigint not null,
      "drift_grams" bigint null,
      "drift_ratio" double precision null,
      "verdict" text not null,
      "reason" text not null,
      "tolerance_ratio" double precision not null,
      "computed_at" timestamptz not null,
      primary key ("id"));`)
    this.addSql(`create index "work_recon_scope_idx" on "work_orders_reconciliations" ("organization_id", "tenant_id");`)
    this.addSql(`create index "work_recon_batch_idx" on "work_orders_reconciliations" ("batch_id", "computed_at");`)
    this.addSql(`create index "work_recon_policy_idx" on "work_orders_reconciliations" ("tenant_id", "policy_version_id");`)
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "work_orders_reconciliations" cascade;`)
    this.addSql(`drop table if exists "work_orders_batches" cascade;`)
    this.addSql(`drop table if exists "work_orders_orders" cascade;`)
  }
}

import { Migration } from '@mikro-orm/migrations'

/**
 * Geometria hali - rzut z góry w metrach.
 *
 * Wszystkie kolumny są `null`-owalne i tak mają zostać. Cela bez kompletu
 * współrzędnych nie jest rysowana, tylko trafia na listę nierozmieszczonych:
 * zmyślona pozycja na planie hali jest gorsza niż jej brak, bo brak widać.
 *
 * Ograniczenie na dodatnie wymiary jest w bazie, a nie tylko w kodzie -
 * cela o zerowej szerokości przeszłaby przez walidację jako „podana"
 * i dała dzielenie przez zero przy skalowaniu.
 */
export class Migration20260919230000_fleet_layout extends Migration {
  override name = 'Migration20260919230000_fleet_layout'

  override up(): void | Promise<void> {
    this.addSql(`alter table "fleet_sites" add column "floor_width_m" double precision null;`)
    this.addSql(`alter table "fleet_sites" add column "floor_height_m" double precision null;`)

    this.addSql(`alter table "fleet_cells" add column "layout_x_m" double precision null;`)
    this.addSql(`alter table "fleet_cells" add column "layout_y_m" double precision null;`)
    this.addSql(`alter table "fleet_cells" add column "layout_width_m" double precision null;`)
    this.addSql(`alter table "fleet_cells" add column "layout_height_m" double precision null;`)
    this.addSql(`alter table "fleet_cells" add column "layout_rotation_deg" double precision null;`)
    this.addSql(`alter table "fleet_cells" add constraint "fleet_cells_layout_size_chk" check (
      ("layout_width_m" is null or "layout_width_m" > 0) and
      ("layout_height_m" is null or "layout_height_m" > 0));`)
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "fleet_cells" drop constraint if exists "fleet_cells_layout_size_chk";`)
    for (const column of ['layout_x_m', 'layout_y_m', 'layout_width_m', 'layout_height_m', 'layout_rotation_deg']) {
      this.addSql(`alter table "fleet_cells" drop column if exists "${column}";`)
    }
    this.addSql(`alter table "fleet_sites" drop column if exists "floor_width_m";`)
    this.addSql(`alter table "fleet_sites" drop column if exists "floor_height_m";`)
  }
}

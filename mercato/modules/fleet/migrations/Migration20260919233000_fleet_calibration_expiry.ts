import { Migration } from '@mikro-orm/migrations'

/**
 * Odhaczenie powiadomienia o wygaśnięciu kalibracji.
 *
 * Kolumna nie mówi „kalibracja wygasła" — to nadal wyprowadzamy z `valid_until`
 * przy odczycie. Mówi „fakt wygaśnięcia został już raz ogłoszony", i tylko
 * dlatego detektor cykliczny może chodzić co godzinę, nie zamieniając
 * zdarzenia w szum.
 */
export class Migration20260919233000_fleet_calibration_expiry extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "fleet_calibrations" add column if not exists "expiry_notified_at" timestamptz null;`)
    /*
     * Indeks częściowy, a nie pełny: detektor pyta wyłącznie o wiersze jeszcze
     * nieogłoszone i nieunieważnione ręcznie. Przy flocie, w której przytłaczająca
     * większość kalibracji jest już obsłużona, pełny indeks byłby prawie w całości
     * martwy.
     */
    this.addSql(`create index if not exists "fleet_calibrations_expiry_pending_idx"
      on "fleet_calibrations" ("valid_until")
      where "expiry_notified_at" is null and "invalidated_at" is null;`)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "fleet_calibrations_expiry_pending_idx";`)
    this.addSql(`alter table "fleet_calibrations" drop column if exists "expiry_notified_at";`)
  }
}

/**
 * Nazwy kolejek modułu.
 *
 * Osobny plik, bo tę samą nazwę wpisuje worker (w metadanych) i rejestracja
 * harmonogramu (w `setup.ts`). Literówka w jednym z tych dwóch miejsc daje
 * zadanie cykliczne, które chodzi i nie robi nic, bo nikt nie słucha na tej
 * kolejce - awaria cicha.
 */
export const FLEET_CALIBRATION_EXPIRY_QUEUE = 'fleet-calibration-expiry'

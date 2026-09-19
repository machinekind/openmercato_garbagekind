/**
 * Nazwy kolejek modułu.
 *
 * Osobny plik, bo tę samą nazwę wpisuje worker (w swoich metadanych)
 * i rejestracja harmonogramu (w `setup.ts`). Literówka w jednym z tych dwóch
 * miejsc daje zadanie cykliczne, które uruchamia się co dobę i nie robi nic,
 * bo nikt nie słucha na tej kolejce — awaria cicha i trudna do zauważenia.
 */
export const VISION_CLIPS_PURGE_QUEUE = 'vision-clips-purge'

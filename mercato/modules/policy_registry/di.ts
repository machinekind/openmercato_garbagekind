import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Bez własnych usług: reguły siedzą w czystych funkcjach (`lib/digest.ts`,
 * `lib/compatibility.ts`), zapis idzie komendami. Punkt rozszerzenia zostaje
 * na wypadek pierwszej usługi wymagającej stanu - np. klienta magazynu obiektów,
 * który i tak nie może przechodzić przez szynę komend.
 */
export function register(_container: AppContainer): void {}

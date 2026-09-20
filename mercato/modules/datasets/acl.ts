/**
 * Uprawnienia zbiorów danych.
 *
 * Podział przebiega między **budowaniem zbioru** a **deklarowaniem, co się
 * na nim uczyło**. To drugie jest zapisem do dziennika pochodzenia, na którym
 * stoi cała diagnoza regresu - i nie powinno być czynnością przypadkową.
 */
export const features = [
  { id: 'datasets.view', title: 'Podgląd zbiorów i pochodzenia', module: 'datasets' },
  { id: 'datasets.build', title: 'Budowanie wersji zbioru', module: 'datasets' },
  { id: 'datasets.train', title: 'Rejestrowanie przebiegów treningowych', module: 'datasets' },
]

export default features

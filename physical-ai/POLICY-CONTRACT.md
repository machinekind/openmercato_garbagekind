# Kontrakt polityki Physical AI

Każda nowa wersja polityki rejestrowana w ERP musi jawnie opisać interfejs,
na którym była trenowana. Sam plik wag i liczba DOF nie wystarczają.

## Wektory

`observationSpec.fields` i `actionSpec.fields` są uporządkowanymi tablicami.
Pozycja pola jest pozycją w wektorze. Każde pole zawiera:

- `key` - stabilną nazwę sygnału;
- `size` - liczbę kolejnych skalarów;
- `unit` - jednostkę z zamkniętego słownika;
- `frame` - jawny układ odniesienia, np. `base_link`, `camera_wrist`,
  `joint_space` albo `none`;
- `semantics` - `absolute`, `delta`, `velocity`, `effort`, `binary` lub
  `encoded`.

Suma `size` musi być równa odpowiednio `observationDim` albo `actionDim`.
Ponadto zapisujemy `trainedDofCount` i `controlFrequencyHz`. Tych samych
artefaktów nie da się ponownie opisać inną jednostką, kolejnością, semantyką
ani częstotliwością.

## Wygaśnięcie dzierżawy

`leaseExpiryBehavior` jest częścią wersji polityki i przyjmuje jedną wartość:

- `hold_position` - przerwij generowanie kolejnych akcji i utrzymaj bieżącą
  bezpieczną pozycję;
- `complete_grasp_then_hold` - dokończ rozpoczęty chwyt, bez rozpoczynania
  kolejnego cyklu, następnie utrzymaj pozycję;
- `return_home` - wykonaj lokalną, zwalidowaną trajektorię powrotu i zatrzymaj
  się w pozycji bazowej.

To zachowanie jest wykonywane lokalnie po upływie `expiresAt`; nie czeka na
odpowiedź ERP. Nie zastępuje E-stopu ani deterministycznej warstwy
bezpieczeństwa. ERP kopiuje wartość do przypisania i zwraca ją agentowi w
odpowiedzi na każde żądanie dzierżawy.

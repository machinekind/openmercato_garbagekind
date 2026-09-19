# Indeks dowodów

## Pomiary fizyczne A1X/A1XY

- `source/robot/diag/REPORT.md` — najważniejszy raport pomiarowy. Rozdziela
  twierdzenia na ustalone, wywnioskowane i nieprzetestowane oraz koryguje
  wcześniejsze błędne interpretacje.
- `source/robot/diag/*.py` — skrypty użyte do prób krokowych, mapowania funkcji,
  chwytaka, `kp` i `t_ff`. Są zachowane dla odtwarzalności, nie jako gotowe
  procedury operatorskie.
- `source/robot/docs/HARDWARE.md` i `PROTOCOL.md` — konfiguracja magistrali,
  identyfikatory ramek, formaty danych i mapowanie stawów.
- `source/robot/docs/SAFETY.md` — ograniczenia sprzętu i reguły uzyskane podczas
  eksperymentów.

## Logi i notatki sesyjne

- `source/docs/knowledge/README.md` — opis pochodzenia i mapowanie sesji.
- `d7ea01b3.md` — 19 września: panel, DGX, tracking i G0.5.
- `400-cdc-d9d.md` — 18–19 września: panel, transmisja obrazu, wybór G0.5.
- `7fb26521.md` — 18–19 września: GR00T, shadow mode i monitoring.
- `mid-sessions.md` — jedenaście krótszych sesji z identyfikatorami i godzinami.
- `so101-trash.md` — 18 września: SO-101 i sortowanie odpadów; część wpisów jest
  researchem, a nie wynikiem fizycznego eksperymentu.

## Stan wykonania zadania pick

- `source/docs/PICK-STATE-OF-PLAY.md` — rozdzielenie elementów działających od
  niedziałających. Ścieżka kolejki działa, lecz autonomiczny chwyt i zbieżność
  dojścia pozostają niezamknięte.
- `source/docs/ROBOT-STACK.md` — architektura panelu, DGX i ramienia.
- `source/robot/presets.json` — operacyjne okno stawów i pozy startowe używane
  w źródłowym panelu.

## Brakujące artefakty źródłowe

Raport wymienia surowe przechwycenia `E0_can1_handmove.log`,
`E0b_can0_handmove.raw`, `E1_can0.raw`, `E1_can1.raw`, `can0_survey.log`,
`can1_survey.log`, serię `E5_*.raw` oraz `verify_can*.raw`. Plików tych nie ma
w commicie źródłowym — wzorce `.log`, `.raw` i `.csv` zostały wykluczone przez
jego `.gitignore`. Brak jest jawny; raportu nie traktujemy jako substytutu
surowych ramek przy późniejszej certyfikacji lub analizie incydentu.

## Najważniejsze ograniczenia bezpieczeństwa

- E-stop nie został fizycznie sprawdzony w opisanej sesji.
- Włączenie napędu bez równoczesnego `p_des = q` spowodowało ruch 76,36° przy
  nasyconym momencie.
- Interfejs CAN-FD zachowuje się jako sterowanie pozycyjne; `t_ff`, `kp`, `kd`,
  `v_des` i `mode` nie zapewniły oczekiwanej podatności.
- Odcięcie zasilania nie jest bezpiecznym zatrzymaniem dla ramienia bez hamulców.
- Dokładnie jeden proces może pisać na magistralę CAN.

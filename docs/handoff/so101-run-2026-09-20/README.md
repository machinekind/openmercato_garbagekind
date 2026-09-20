# Dziennik przebiegu SO-101 - 2026-09-20

**To nie jest paczka dowodowa P0.** Przebieg zawiera wartości zastępcze, więc
`seal` i `finalize` odmówiły działania i rewizja `r2` nie powstała. Dokument
jest zapisem tego, co faktycznie wykonano na podłączonym ramieniu.

- Host: Linux 6.17.10-100.fc41.x86_64
- Port: `/dev/ttyACM0`, przejściówka `1A86:55D3`, S/N `5AAF220303`
- `runRef`: `52d963fd-bc08-476a-b9d6-a234270f94c4`
- Narzędzie: `mercato/hardware/so101/validate.py` 1.5.0

## Etap A - `validate.py`

| Krok | Polecenie | Wynik |
| --- | --- | --- |
| A1 wykrycie portu | `scan` | `passed` - znaleziona przejściówka S/N `5AAF220303` |
| A1 magistrala | `inspect --port /dev/ttyACM0` | `passed` - sześć STS3215, ID 1-6, firmware 3.10, `Torque_Enable` = 0 na wszystkich |
| A2 kalibracja | `calibrate` | **nie wykonano** - procedura LeRobot jest interaktywna i wymaga ręcznego przeprowadzenia każdego stawu przez pełny zakres |
| A3 zasięg i udźwig | `measure --placeholder` | `placeholder` / `provenance: synthetic` - nie jest pomiarem |
| A4 zasilanie | `power --placeholder` | `placeholder` / `provenance: synthetic` - nie jest pomiarem |
| A5 wyłączenie momentu | `torque-off --port /dev/ttyACM0` | `passed` - `Torque_Enable` = 0 na sześciu serwach po komendzie |
| A6 E-stop i limity | `safety` | **nie wykonano** - zestaw nie ma sprzętowego E-stopu ani przerywacza dwukanałowego, więc nie ma czego zmierzyć |
| A7 artefakty polityki | `artifacts` | **nie wykonano** - brak lokalnego katalogu polityki i `declaredSpecDigest` z metadanych treningu |
| A8 zapieczętowanie | `seal` | `BLOCKED: Physical evidence is incomplete: jointOffsets, power, reach, payload, emergencyStop, deterministicLimits` |
| A9 rewizja | `finalize` | `BLOCKED` - brak zapieczętowanego raportu |

Odczyt rejestrów kalibracji (`jointOffsetsObserved`) ma status `observed`,
SHA-256 `c0123b791105dcb8922287f5a2274725e10a4be2a0b2e336206d1b1aac52c9b4`.
Same rejestry nie dowodzą, że pełna procedura LeRobot została przeprowadzona.

Surowy raport: [`evidence.json`](evidence.json).

## Demonstracja ruchu przez MCP

Tryb osobny od odbioru; nie produkuje dowodów P0. Serwer
`mercato/hardware/so101/mcp_server.py`, port `/dev/ttyACM0`.

| Czas UTC | Narzędzie | Wynik |
| --- | --- | --- |
| 07:45:40 | `so101_enable` | `enabled` - moment załączony przy pozie zastanej, odchyłka 0 ticków przez 500 ms |
| 07:45:52 | `so101_random_pose` (delta 10°, seed 7) | `reached` - `shoulder_pan` 2016→1990, `shoulder_lift` 1238→1314, maks. błąd 2,2°, 0,32 s, brak zatrzymań na obciążeniu |
| 07:45:57 | `so101_release` (`return_home=true`) | `released` - powrót do pozy zastanej (maks. błąd 0,97°), potem moment zwolniony na sześciu stawach |

Ramię zostało na końcu bez momentu, w pozie zastanej z chwili załączenia.

Surowy dziennik: [`motion-journal.ndjson`](motion-journal.ndjson).

## Uwaga do stanu wyjściowego

W chwili startu dwa stawy leżały poza oknem miękkich limitów liczonym przez
`arm_control.py`: `shoulder_lift` 1238 przy oknie 1320-3495 oraz `elbow_flex`
2878 przy oknie 781-2764. `so101_enable` utrzymuje pozę zastaną, więc
załączenie było bezpieczne, ale „dom" zapamiętany przy załączeniu leżał poza
oknem. Powrót i zwolnienie mimo to przeszły.

## Czego brakuje do Z1

`jointOffsets` (pełna kalibracja LeRobot), `reach`, `payload`, `power`
(pomiary przyrządami), `emergencyStop` i `deterministicLimits` (sprzętowa
warstwa zatrzymania). Bez sprzętowego E-stopu warunek Z5 z
[`../so101-odbior-fizyczny.md`](../so101-odbior-fizyczny.md) pozostaje
niespełniony, a poza demonstracją nie wolno na tym sprzęcie uruchamiać
polityki.

# Kategorie przyczyn interwencji Physical AI

Kontrakt obowiązuje od 2026-09-19 dla `episodes.interventions.record` oraz
podpisanego wejścia `POST /api/edge/telemetry`. Pole `reasonCategory` przyjmuje
wyłącznie wartości z poniższej tabeli. Szczegóły zdarzenia pozostają w polu
`reason`; nie należy tworzyć nowych kategorii przez zmianę pisowni.

| Wartość | Kiedy używać |
| --- | --- |
| `grasp_failure` | Chwyt nie powstał, detal wypadł albo chwytak zamknął się bez detalu. |
| `object_not_detected` | Percepcja nie znalazła oczekiwanego obiektu lub klasy. |
| `workspace_obstruction` | Nieoczekiwany przedmiot lub pojemnik blokuje przestrzeń zadania. |
| `person_in_safety_zone` | Człowiek naruszył chroniony obszar robota. |
| `policy_stall` | Polityka nie zwróciła postępu lub powtarzała działanie bez postępu. |
| `unsafe_motion` | Plan albo rzeczywisty ruch został oceniony jako niebezpieczny. |
| `joint_limit` | Polecenie lub stan naruszył limit stawu, prędkości albo momentu. |
| `camera_fault` | Brak obrazu, zasłonięcie, błędne urządzenie lub uszkodzony strumień. |
| `tracking_loss` | Utracono ciągłość ścieżki człowieka, obiektu lub robota. |
| `material_jam` | Materiał zakleszczył chwytak, przenośnik, zsyp lub pojemnik. |
| `power_fault` | Brak albo niewłaściwe zasilanie napędów lub urządzenia wykonawczego. |
| `hardware_fault` | Awaria sprzętu niepasująca do zasilania ani limitu stawu. |
| `communications_loss` | Utrata CAN, sieci, sterownika, DGX albo innego kanału sterowania. |
| `calibration_error` | Kalibracja wygasła, jest brakująca albo niezgodna z obserwacją. |
| `operator_request` | Operator zatrzymał lub przejął pracę z przyczyny procesowej. |
| `other` | Wyjątek; pole `reason` musi jednoznacznie opisać przypadek do późniejszej klasyfikacji. |

`kind` odpowiada na pytanie **co zrobił operator** (`adjust`, `manual_reset`,
`teleop_takeover`, `abort`, `estop`), a `reasonCategory` - **dlaczego**. Dlatego
np. E-stop po wejściu człowieka ma `kind: estop` i
`reasonCategory: person_in_safety_zone`.

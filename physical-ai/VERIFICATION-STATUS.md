# Stan weryfikacji integracji Physical AI

Stan na **2026-09-20**, gałąź `main`.

Ten dokument oddziela weryfikację programu od odbioru fizycznego. Zielony
wynik testów nie jest dowodem, że robot lub warstwa bezpieczeństwa zostały
sprawdzone na stanowisku.

## Zweryfikowane programowo

| Zakres | Wynik | Punkt odniesienia |
| --- | --- | --- |
| Pełne sprawdzenie typów ERP | zaliczone | `4f631d4`, potwierdzone po `c0f5c29` |
| Pełny zestaw testów ERP | zaliczony w klonie platformy; liczby przebiegu nie są tu podawane, bo tego zestawu nie da się uruchomić z tego repozytorium | `c0f5c29` |
| Testy podpisanej telemetrii edge i retencji wideo | 45/45 testów | `c6386a8` |
| Testy narzędzia odbioru SO-101 | 24/24 testy (`tests/test_so101_validation.py`) | `main` |
| Testy integralności paczki dowodowej | 8/8 testów (`tests/test_evidence_bundle.py`) | `d3e0fdc` |
| Testy sterownika ruchu SO-101 | 24/24 testy (`tests/test_so101_arm_control.py`) | `main` |
| Cały zestaw pythonowy tego repozytorium | 107/107 testów, `python3 -m unittest discover -s tests -t .` | `main` |
| Kompilacja składni narzędzi sprzętowych | zaliczona | `d3e0fdc` |
| Źródłowy bridge A1X z `mercatoXD` | 56/56 testów, 84% pokrycia, bez sprzętu | commit źródła `fd5fe08` |

Pełny zestaw ERP zawiera testy, które celowo wywołują błędy usług i zapisują
komunikaty `WARN` lub `ERROR`. O wyniku decyduje podsumowanie Jest; cały
zestaw zakończył się kodem `0`.

## Zweryfikowane po stronie kontraktów

- telemetria obrazu, epizodów i interwencji jest przyjmowana podpisanym
  kanałem edge; organizacja, tenant, robot i autor potwierdzenia usunięcia są
  wyprowadzane z sesji;
- ERP przechowuje URI, metadane i skróty nagrań, a nie bajty wideo;
- raport odbioru SO-101 można zamknąć poleceniem `seal`; kolejna rewizja
  embodimentu otrzymuje obliczony SHA-256 oraz `runRef` tego samego przebiegu;
- kalibracja wymaga jawnej daty ważności i niepewności, a artefakty polityki
  mają role, docelowe URI, SHA-256, niezależny `declaredSpecDigest` oraz
  pochodzenie treningu i zbioru danych;
- paczka P0 jest sprawdzana pod kątem wymaganych prób, zgodności `runRef`,
  czasu UTC, anonimizacji, retencji, zamkniętych słowników i sum wszystkich
  plików; nieudana próba pozostaje ważnym dowodem, ale nie przechodzi bramy;
- próba człowieka w strefie musi wskazywać istniejącą interwencję ERP z
  kategorią `person_in_safety_zone`; warstwa bezpieczeństwa zapisuje również,
  czy jest możliwa do obejścia lub wyłączenia;
- narzędzie odmawia finalizacji przy braku któregokolwiek wymaganego dowodu
  fizycznego i nie nadpisuje istniejącej rewizji;
- zachowanie polityki po wygaśnięciu dzierżawy i słowniki przyczyn alarmów są
  kontraktami zamkniętymi, a nie swobodnym tekstem.

## Odbiór fizyczny - stan częściowy

Pierwszy host weryfikujący (Windows) nie wykrył portu COM ani adaptera
Feetech. Na hoście linuksowym 2026-09-20 ramię odpowiedziało na
`/dev/ttyACM0` i część procedury została wykonana.

Wykonane i zaliczone na podłączonym ramieniu:

- odczyt sześciu serw STS3215, ID 1-6, firmware 3.10 (`inspect`, `passed`);
- próba torque-off: `Torque_Enable` = 0 na sześciu serwach (`passed`).

Nadal niewykonane i niezaliczone:

- oficjalna kalibracja LeRobot (procedura interaktywna, wymaga operatora);
- pomiar napięcia pod obciążeniem, zasięgu i udźwigu (brak przyrządów);
- fizyczny E-stop i limity lokalne (zestaw nie ma deterministycznej warstwy
  zatrzymania, więc nie ma czego zmierzyć);
- próby z człowiekiem w strefie, polityka cieniowa, autonomiczny chwyt.

`seal` i `finalize` odmówiły działania na brakujących dowodach, więc rewizja
`r2` nie powstała i nic nie jest oznaczone jako `verifiedAgainstHardware`.
Kroki bez przyrządów mają w raporcie status `placeholder` i
`provenance: synthetic` - nie zostały zastąpione mockiem ani wartością
katalogową. Pełny zapis przebiegu:
`docs/handoff/so101-run-2026-09-20/README.md`.

Inwentaryzacja materiału `mercatoXD` względem naszych bram znajduje się w
`physical-ai/MATERIAL-MERCATOXD.md`. Kod bridge'a przeszedł testy, ale
repo źródłowe nie zawiera surowych logów, datasetu, wag ani zakończonego
autonomicznego chwytu, więc nie zmienia statusu fizycznych bramek P0-P3.

## Warunek następnego odbioru

Zespół physical powinien przejść procedurę z
`mercato/hardware/so101/README.md`, zachować ciężkie logi i media w magazynie
edge/DGX, zamknąć raport oraz przekazać jego URI i SHA-256. Dopiero powstała z
tego raportu kolejna rewizja `so101_follower` może być oznaczona jako
`verifiedAgainstHardware: true`.

Pozostałe próby P0-P3 i format paczki dowodowej są prowadzone w
`physical-ai/PHYSICAL-VALIDATION-BACKLOG.md`.

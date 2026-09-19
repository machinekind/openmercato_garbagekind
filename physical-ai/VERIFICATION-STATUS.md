# Stan weryfikacji integracji Physical AI

Stan na **2026-09-19**, gałąź `ERP-Physical-management`.

Ten dokument oddziela weryfikację programu od odbioru fizycznego. Zielony
wynik testów nie jest dowodem, że robot lub warstwa bezpieczeństwa zostały
sprawdzone na stanowisku.

## Zweryfikowane programowo

| Zakres | Wynik | Punkt odniesienia |
| --- | --- | --- |
| Pełne sprawdzenie typów ERP | zaliczone | `4f631d4`, potwierdzone po `c0f5c29` |
| Pełny zestaw testów ERP | 153/153 zestawy, 1354/1354 testy | `c0f5c29` |
| Testy podpisanej telemetrii edge i retencji wideo | 45/45 testów | `c6386a8` |
| Testy narzędzia odbioru SO-101 | 6/6 testów | `34b3ba7` |
| Testy integralności paczki dowodowej | 7/7 testów | `a23a350` |
| Kompilacja składni narzędzia SO-101 | zaliczona | `34b3ba7` |

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
- paczka P0 jest sprawdzana pod kątem wymaganych prób, zgodności `runRef`,
  czasu UTC, anonimizacji, retencji, zamkniętych słowników i sum wszystkich
  plików; nieudana próba pozostaje ważnym dowodem, ale nie przechodzi bramy;
- narzędzie odmawia finalizacji przy braku któregokolwiek wymaganego dowodu
  fizycznego i nie nadpisuje istniejącej rewizji;
- zachowanie polityki po wygaśnięciu dzierżawy i słowniki przyczyn alarmów są
  kontraktami zamkniętymi, a nie swobodnym tekstem.

## Niewykonany odbiór fizyczny

Na hoście wykonującym tę weryfikację system Windows nie wykrył portu COM ani
adaptera Feetech. Widoczna była kamera USB, ale nie magistrala napędów.
Dlatego nie wykonano i nie zaliczono:

- odczytu sześciu serw SO-101 i oficjalnej kalibracji LeRobot;
- pomiaru napięcia pod obciążeniem, zasięgu i udźwigu;
- próby torque-off, fizycznego E-stopu ani lokalnych limitów;
- prób z człowiekiem w strefie, polityki cieniowej ani autonomicznego chwytu.

Brak urządzenia pozostaje stanem `blocked` w raporcie roboczym poza Git. Nie
został zastąpiony mockiem ani wartością katalogową.

## Warunek następnego odbioru

Zespół physical powinien przejść procedurę z
`mercato/hardware/so101/README.md`, zachować ciężkie logi i media w magazynie
edge/DGX, zamknąć raport oraz przekazać jego URI i SHA-256. Dopiero powstała z
tego raportu kolejna rewizja `so101_follower` może być oznaczona jako
`verifiedAgainstHardware: true`.

Pozostałe próby P0–P3 i format paczki dowodowej są prowadzone w
`physical-ai/PHYSICAL-VALIDATION-BACKLOG.md`.

# Moduły

Piętnaście modułów rozszerzających Open Mercato. Instaluje je `mercato/install.sh`
do klonu platformy - to repozytorium pozostaje źródłem prawdy.

## Mapa

Kolejność nie jest alfabetyczna, tylko od fundamentu w górę: moduł niżej nie
wie o istnieniu modułu wyżej.

| Moduł | Odpowiada za | Zależy od |
| --- | --- | --- |
| [`fleet`](fleet) | rejestr robotów, klas sprzętowych, obiektów, cel i kalibracji - z **rozdziałem właściciela od operatora** | - |
| [`hmi`](hmi) | system wizualny wg ISA-101: żetony, słownik stanów, norma szara, kolor wyłącznie dla odstępstwa | - |
| [`digital_twins`](digital_twins) | model przestrzenny pomieszczenia ze skanu, rejestr kamer, anonimowe śledzenie | - |
| [`policy_registry`](policy_registry) | wersje polityk sterowania: kontrakt wektora obserwacji i akcji, artefakty ze skrótami, zachowanie po wygaśnięciu dzierżawy | `fleet` |
| [`vision`](vision) | kamery, detektory i zliczenia obiektów jako **trzeci świadek** obok deklaracji robota i wagi | `fleet` |
| [`compute`](compute) | rejestr zdolności obliczeniowych i przypisań - z zakazem pełnienia funkcji bezpieczeństwa | `fleet` |
| [`safety`](safety) | uzasadnienia bezpieczeństwa per klasa celi, zestawy ewaluacyjne, incydenty, bramka dopuszczenia | `fleet`, `policy_registry` |
| [`episodes`](episodes) | księga epizodów i interwencji człowieka - liczby, na których stoi brama wdrożenia | `fleet`, `policy_registry` |
| [`edge`](edge) | tożsamość kryptograficzna agenta, sesje łączności, podpisany kanał telemetrii | `fleet`, `episodes`, `vision` |
| [`deployment`](deployment) | stan pożądany floty wydawany na czas ograniczony **dzierżawą**, uzgadnianie ze stanem faktycznym | `fleet`, `policy_registry`, `edge`, `safety` |
| [`rollout`](rollout) | wdrożenia etapowe z bramą liczbową i automatycznym wycofaniem | `fleet`, `policy_registry`, `deployment`, `episodes` |
| [`datasets`](datasets) | zamknięcie pętli uczenia: zbiory z pochodzeniem i wersją | `fleet`, `policy_registry`, `episodes` |
| [`work_orders`](work_orders) | most hala ↔ przedsiębiorstwo: praca robota staje się masą w magazynie, a **waga sprawdza robota** | `fleet`, `episodes`, `catalog`, `wms` |
| [`physical_management`](physical_management) | rzut hali i pulpit operatorski nad powyższymi | `fleet`, `vision`, `hmi` |
| [`sortownia`](sortownia) | most do systemu legacy i ewidencja magazynowo-sprzedażowa sortowni | `wms`, `catalog`, `data_sync` |

`catalog`, `wms` i `data_sync` to moduły platformy Open Mercato, nie nasze.

**Warstwa robotyczna nie zależy od `sortownia`.** To jest warunek, pod którym
ta wtyczka nadaje się do zakładu innego niż sortownia odpadów, i jest
egzekwowany: `work_orders/index.ts` wprost nie wymienia `sortownia` w `requires`,
a jedyne wzmianki o niej w warstwie robotycznej to komentarze.

## Układ modułu

```
<modul>/
  index.ts          metadane, `requires`, rejestracja
  acl.ts            uprawnienia
  setup.ts          wpisy zakładane przy instalacji
  data/entities.ts  encje MikroORM
  migrations/       jawne migracje, jedna na zmianę schematu
  commands/         jedyna droga zapisu
  lib/              czyste funkcje - logika współdzielona i wołana spoza komend
  api/              trasy HTTP
  backend/          ekrany
  components/       komponenty Reacta
  widgets/          kafelki pulpitu głównego
  events.ts         zdarzenia z typowanym ładunkiem
  i18n/             pl.json, en.json
  cli.ts            polecenia obsługowe
  __tests__/        testy jednostkowe
  __integration__/  testy przeciwko uruchomionej instancji
```

Nie każdy moduł ma wszystkie katalogi - ma te, które są mu potrzebne.

## Reguły, które wiążą moduły

1. **Moduł nie importuje encji innego modułu.** Klasa encji zarejestrowana pod
   dwiema ścieżkami daje „Metadata for entity X not found" po stronie, która
   zgubi kolejność ładowania. Odczyt z obcej tabeli idzie surowym SQL-em
   (moduł zna **tabelę**, nie klasę), logika współdzielona - przez plik czystych
   funkcji w `lib/` sąsiada.
2. **Szyna komend jest kanałem zapisu, nie odczytu.** Wołanie komendy po dane
   dokłada warstwę bez żadnej gwarancji w zamian.
3. **Plik z komendami nie jest biblioteką.** Funkcja wołana spoza komend idzie
   do `lib/`, inaczej leniwy loader zarejestruje komendę drugi raz.
4. **Co platforma zasiewa przy inicjalizacji tenanta** - uprawnienia ról,
   harmonogramy, listy kafelków - jest dla modułu doinstalowanego później
   niedostępne, a brak nie objawia się błędem, tylko ciszą. Stąd idempotentne
   `install-schedules` i `install-widgets` w `cli.ts`.

## Instalacja

```bash
export MERCATO_ROOT=~/open-mercato
./mercato/install.sh                 # wszystkie moduły
./mercato/install.sh fleet edge      # wybrane
(cd "$MERCATO_ROOT/apps/mercato" && yarn generate && yarn mercato db migrate)
```

Moduły są **kopiowane**, nie dowiązywane - Turbopack nie rozwiązuje dowiązań
spoza katalogu projektu. Po każdej zmianie w tym repozytorium uruchom skrypt
ponownie.

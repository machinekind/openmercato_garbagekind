# Sortownia → Physical AI

Repozytorium prowadzone etapami, każdy na własnej gałęzi. **Ta gałąź to
`physical_ai`** i zawiera wszystko z etapów wcześniejszych plus warstwę
robotyczną.

| Gałąź | Co zawiera | Stan |
| --- | --- | --- |
| `claude/quirky-hypatia-1afn6m` | serwer XML-RPC w dialekcie webERP + klient CSV | zamknięta |
| `legacy_erp` | generator danych legacy, saldo magazynu liczone z księgi | zamknięta |
| `mercato_erp` | moduł `sortownia`: pełna ścieżka ERP na Open Mercato | zamknięta |
| **`physical_ai`** | osiem modułów robotycznych + kafelek embodimentu | **bieżąca** |

## Mapa tej gałęzi

| Ścieżka | Co tam jest |
| --- | --- |
| [`physical-ai/README.md`](physical-ai/README.md) | teza, warunki brzegowe, konsekwencja regulacyjna, stan implementacji i **dowody wszystkich faz** |
| [`physical-ai/ROADMAP.md`](physical-ai/ROADMAP.md) | mapa faz 0–6: co dostarcza, czego świadomie nie ma, co jest dowodem zamknięcia |
| [`physical-ai/EMBODIMENTS.md`](physical-ai/EMBODIMENTS.md) | format opisu ramienia, SO-101 jako wzorzec i **cztery usterki, które ujawnił** |
| [`physical-ai/ERP-BRIDGE.md`](physical-ai/ERP-BRIDGE.md) | most hala ↔ ERP: waga rozstrzyga o zapasie, deklaracja robota o ocenie robota |
| [`physical-ai/VISION.md`](physical-ai/VISION.md) | wzrok maszynowy jako **trzeci świadek** — i granice prawne monitoringu egzekwowane w kodzie |
| [`physical-ai/COMPUTE.md`](physical-ai/COMPUTE.md) | gdzie postawić DGX Sparka, a gdzie go **nie** stawiać — i co z tego wynikło w kodzie |
| [`physical-ai/PLANT-VIEW.md`](physical-ai/PLANT-VIEW.md) | rzut hali: rozmieszczenie, status i wynik — oraz dlaczego brak obmiaru nie jest zgadywany |
| [`physical-ai/HMI.md`](physical-ai/HMI.md) | system wizualny wg ISA-101 — i dlaczego pierwsza wersja rzutu była źle zaprojektowana |
| [`physical-ai/OPERATIONS.md`](physical-ai/OPERATIONS.md) | zadania cykliczne — i dlaczego automatyzacja oznaczania **nie** dawała zgodności |
| [`physical-ai/EVENTS.md`](physical-ai/EVENTS.md) | co wtyczka **ogłasza**, czego świadomie nie ogłasza i dlaczego ruch o częstotliwości maszynowej nie jest faktem |
| `mercato/modules/` | trzynaście modułów Open Mercato (`sortownia` + jedenaście robotycznych + `hmi` jako system wizualny) |
| `mercato/embodiments/` | opisy ramion; `so101_follower.json` z dokumentacji LeRobot |
| `legacy/`, `client/`, `webui/` | system legacy z etapów wcześniejszych — opisany niżej |

### Uczciwa etykieta całości

Warstwa robotyczna **nie widziała dotąd żadnego prawdziwego robota**. Wszystkie
dane pochodzą z naszych własnych komend `seed` i `prove`. To jest wykonywalny
dokument projektowy z odtwarzalnymi dowodami zachowania, a nie oprogramowanie
sprawdzone w ruchu. Pełna ocena wartości i lista tego, czego brakuje, jest
w `physical-ai/EMBODIMENTS.md` oraz w sekcji „Stan po fazach 0–6".

### Uruchomienie warstwy robotycznej

```bash
./mercato/install.sh                     # wszystkie moduły do klonu Open Mercato
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato fleet seed
yarn mercato fleet embodiment --file .../mercato/embodiments/so101_follower.json
```

---

# Prymitywny system legacy sortowni (etapy wcześniejsze)

Wiarygodne źródło danych „sprzed epoki”, z którego Open Mercato zasysa dane przez
XML-RPC — bez instalowania prawdziwego webERP w środku hackatonu.

## Uczciwa etykieta

Ten system **nie jest webERP**. Mówi dialektem XML-RPC prawdziwego webERP: te same
nazwy metod (`weberp.xmlrpc_*`), ta sama mechanika sesji (logowanie zwraca kod
liczbowy, autoryzacja jedzie dalej ciasteczkiem `PHPSESSID`), te same nazwy pól
w danych (`debtorno`, `stockid`, `loccode`, `qty`) i ta sama ścieżka endpointu.
Dzięki temu klient napisany przeciw temu systemowi zadziała przeciw prawdziwej
instancji webERP po zmianie jednego URL-a.

Zdanie, które wolno powiedzieć ze sceny:

> Po drugiej stronie stoi system legacy mówiący XML-RPC, protokołem z 1998 roku,
> odwzorowany na podstawie rzeczywistego API webERP.

Zdanie, którego powiedzieć **nie wolno**: „zintegrowaliśmy się z webERP”.

**Żadnych metod wymyślonych.** Powierzchnia XML-RPC zawiera wyłącznie metody,
które w webERP istnieją. Danych, których webERP przez XML-RPC nie wystawia,
nie udajemy zaślepką — przychodzą tam, skąd przychodzą w prawdziwym wdrożeniu:
z drugiej bazy, z raportu, z excelka podesłanego przez księgowość.

## Dwa kanały danych

| Kanał | Co daje | Czym jest w prawdziwym wdrożeniu |
| --- | --- | --- |
| XML-RPC (`legacy/server.py`) | dane kontrahenta, lista i szczegóły lokalizacji, stany magazynowe, nagłówki wydań | API webERP, jeden do jednego |
| Zrzut plikowy (`legacy/spooler.py` → katalog `wsad/`) | katalog kontrahentów (same klucze), katalog frakcji, księga ruchów | nocny eksport, raport z innej bazy, excelek z księgowości |

Klient (`client/weberp_sync.py`) łączy oba: klucze bierze ze zrzutu, a wartości
— gdzie się da — dociąga po XML-RPC. `wsad/ruchy.xlsx` czyta własnym czytnikiem
`.xlsx` (`legacy/xlsx.py`, sama biblioteka standardowa), więc podmiana tego pliku
na prawdziwy arkusz od księgowości nie wymaga zmiany kodu.

Podział danych wygląda tak:

| Plik wynikowy | Klucze | Wartości |
| --- | --- | --- |
| `kontrahenci.csv` | `wsad/kontrahenci.csv` | `xmlrpc_GetCustomer` |
| `frakcje.csv` | `wsad/frakcje.csv` | `wsad/frakcje.csv` |
| `lokalizacje.csv` | `xmlrpc_GetLocationList` | `xmlrpc_GetLocationDetails` |
| `stany.csv` | frakcje × lokalizacje | `xmlrpc_GetStockBalance` |
| `ruchy.csv` | `wsad/ruchy.xlsx` | `wsad/ruchy.xlsx` |

## Szybki start

Wymagania: Python 3.11+, wyłącznie biblioteka standardowa. Żadnych zależności.

```bash
./run_demo.sh                              # generator -> serwer + spooler -> klient pełny -> przyrostowy
PAUSE=5 ./run_demo.sh --reserve-step 3     # szybsza wersja na próbę
```

Albo krok po kroku:

```bash
python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
python3 legacy/server.py   --db legacy/sortownia.db --port 8088       # kanał XML-RPC
python3 legacy/spooler.py  --db legacy/sortownia.db --wsad legacy/wsad --interval 5   # kanał plikowy
python3 client/weberp_sync.py --url http://127.0.0.1:8088/api/api_xml-rpc.php \
    --wsad legacy/wsad --out out --full
python3 client/weberp_sync.py --out out        # kolejne uruchomienia: tryb przyrostowy
```

Konto testowe: `demo` / `demo`, firma `weberpdemo`. Inne uwierzytelnianie jest poza zakresem.

## Interfejs użytkownika

`webui/simag.html` to makieta siermiężnego UI systemu legacy: kartoteki,
księga ruchów, stany w układzie krzyżowym, ekran eksportu. Otwiera się
bezpośrednio w przeglądarce, dane generuje po stronie klienta tym samym ziarnem
co `legacy/generate.py` — to poglądowa replika, nie widok na bazę.

## Model danych

Nazwy tabel i pól celowo z webERP, łącznie z jego dziwactwami (kontrahent to `debtor`).

| Tabela | Zawartość | Kluczowe pola |
| --- | --- | --- |
| `debtorsmaster` | kontrahenci: dostawcy i odbiorcy razem | `debtorno, name, address1, address2, debtortype, currcode, clientsince, creditlimit` |
| `stockmaster` | frakcje jako pozycje magazynowe | `stockid, description, categoryid, units, actualcost, decimalplaces` |
| `locations` | boksy i magazyny | `loccode, locationname, deladd1` |
| `locstock` | stany magazynowe | `stockid, loccode, quantity` |
| `stockmoves` | księga ruchów, serce systemu | `stkmoveno, stockid, type, loccode, trandate, debtorno, qty, standardcost` |
| `salesorders` | wydania do odbiorcy | `orderno, debtorno, orddate, deliverydate, stockid, qty, unitprice` |

**Jednostki.** Legacy trzyma masy w kilogramach, bo tak robią stare systemy.
Open Mercato normalizuje do Mg. Konwersja jest świadomym elementem demo:
pokazuje realny problem migracyjny, a nie tylko przepisanie wierszy — klient
emituje obie wartości (`ilosc_kg`, `ilosc_mg`).

**Typy ruchu** (`stockmoves.type`): `PZ` przyjęcie odpadu na plac, `SORT`
wysortowanie frakcji, `WZ` wydanie do odbiorcy (ilość ujemna, konwencja webERP).
Prawdziwy webERP używa w tym miejscu numerycznych `systypes`. To uproszczenie
jest świadome i oznaczone w schemacie, żeby nikt nie budował na nim fałszywej precyzji.

**`SORT` to para wierszy**, jak przesunięcie międzymagazynowe: minus na placu
przyjęć, plus w boksie. Generator prowadzi saldo i pozwala wydać albo wysortować
tylko tyle, ile naprawdę leży, więc **żaden stan nie schodzi poniżej zera** —
pilnuje tego test. Bioodpady jadą wprost z placu do kompostowni i nie mają
ruchu `SORT`.

## Zbiory danych

* **Zbiór bazowy (historia)** — stan, który „od lat siedzi w starym systemie”:
  8 kontrahentów, 6 frakcji, 6 lokalizacji, stany magazynowe i ok. 200 ruchów
  z ostatnich 30 dni. To migrujecie na scenie w akcie pierwszym.
* **Zbiór zapasowy (input testowy)** — ok. 60 dodatkowych ruchów ze znacznikami
  czasu ustawionymi do przodu (domyślnie co 20 s od chwili generowania).
  Spooler zrzuca do `wsad/ruchy.xlsx` wyłącznie ruchy, których `trandate` już
  minęła, więc plik rośnie i kolejne uruchomienia klienta znajdują nowe rekordy.
  Na scenie daje to efekt żywej synchronizacji przyrostowej; poza sceną służy
  jako input testowy do sprawdzania, czy import nie duplikuje i nie gubi rekordów.

Tempo ujawniania: `python3 legacy/generate.py --reserve-step 5`.
Ziarno generatora jest stałe — ta sama baza przy każdym uruchomieniu.

## Powierzchnia XML-RPC

Endpoint: `POST /api/api_xml-rpc.php` (ścieżka celowo taka jak w webERP).

| Metoda | Argumenty | Zwraca |
| --- | --- | --- |
| `weberp.xmlrpc_Login` | `user, password, company` | `int`, `0` = sukces, plus `Set-Cookie: PHPSESSID` |
| `weberp.xmlrpc_GetCustomer` | `debtorno` | jeden kontrahent |
| `weberp.xmlrpc_GetLocationList` | brak | lista lokalizacji |
| `weberp.xmlrpc_GetLocationDetails` | `loccode` | jedna lokalizacja |
| `weberp.xmlrpc_GetStockBalance` | `stockid, loccode` | stan magazynowy |
| `weberp.xmlrpc_GetSalesOrderHeader` | `orderno` | nagłówek wydania |

Dyspozytor ma jawną listę dozwolonych nazw (`ALLOWED_METHODS`); wszystko poza
nią, łącznie z kuszącymi `GetCustomerList`, `GetStockList` czy
`GetStockMovesSince`, to `Fault -32601`. Pilnuje tego osobny test.

Kody zwrotne: `0` logowanie OK, `3` złe dane logowania, `4` zła firma,
`-1` brak ważnej sesji, `-2` brak rekordu. Każda metoda poza `Login` zwraca `-1`
bez ważnej sesji — to celowe, bo w prawdziwym webERP ta ścieżka wywróci klienta
jako pierwsza, i jest pokryta testem.

## Kontrakt wyjściowy dla Open Mercato

Klient zapisuje pliki CSV gotowe pod import w hubie `data_sync` albo `sync_excel`:

| Plik | Kolumny |
| --- | --- |
| `out/kontrahenci.csv` | `debtorno, name, typ, miasto, waluta, klient_od` |
| `out/frakcje.csv` | `stockid, nazwa, kategoria, jednostka, koszt` |
| `out/lokalizacje.csv` | `loccode, nazwa, adres` |
| `out/stany.csv` | `stockid, loccode, ilosc_kg, ilosc_mg` |
| `out/ruchy.csv` | `stkmoveno, stockid, typ, loccode, data, debtorno, ilosc_kg, ilosc_mg` |
| `out/.last_sync` | znacznik czasu ostatniej synchronizacji (tryb przyrostowy) |

Słowniki i stany są nadpisywane pełnym snapshotem; `ruchy.csv` jest dopisywany
przyrostowo z kontrolą duplikatów po `stkmoveno`.

**Znacznik `.last_sync`** jest zapisywany jako najnowsza `trandate` minus jedna
sekunda. Filtr jest ostry (`trandate > since`), a ruchy mogą dzielić tę samą
sekundę — cofnięcie o sekundę chroni przed zgubieniem rekordu z granicy,
a powstałe nakładanie odsiewa kontrola po `stkmoveno`. Świadomie wybrano
„powtórzyć i odsiać” zamiast „pominąć i zgubić”.

## Przestawienie na prawdziwy webERP

```bash
python3 client/weberp_sync.py \
  --url https://twoj-weberp.example/api/api_xml-rpc.php \
  --user <user> --password <haslo> --company <firma> \
  --wsad /sciezka/do/eksportu --out out --full
```

Kanał XML-RPC działa bez zmian w kodzie: logowanie, sesja i wszystkie pięć metod
danych istnieją w webERP. Kanał plikowy trzeba podłączyć pod prawdziwy eksport —
`kontrahenci.csv`/`.xlsx` z kolumną `debtorno`, `frakcje.csv`/`.xlsx` z kolumnami
`stockid, description, categoryid, units, actualcost`, `ruchy.xlsx`/`.csv`
z kolumnami `stkmoveno, stockid, type, loccode, trandate, debtorno, qty,
standardcost`. Klient przyjmuje CSV i XLSX zamiennie (`.xlsx` ma pierwszeństwo).

## Testy

```bash
python3 -m unittest discover -s tests -t . -v
```

Pokrywają kryteria gotowości z rozdziału 6 specyfikacji: generator i zrzut
plikowy, logowanie z ciasteczkiem, ścieżka `-1` bez sesji, brak metod spoza
webERP (po stronie serwera i klienta), czytelność excelka, narastanie zrzutu
w czasie, komplet plików CSV, tryb przyrostowy bez duplikatów i bez gubienia
rekordów.

## Poza zakresem

Księgowość, plan kont, podatki, uwierzytelnianie inne niż jedno konto testowe,
jakiekolwiek zapisy z powrotem do legacy. System jest tylko źródłem danych, nigdy
celem zapisu. Robot pisze do Open Mercato, nie tutaj — serwer i spooler otwierają
bazę SQLite w trybie tylko do odczytu (`mode=ro`) i nie wystawiają żadnej metody
zapisującej.

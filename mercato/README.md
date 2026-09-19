# Moduł `sortownia` dla Open Mercato

Most między systemem legacy sortowni (ten sam repozytorium, gałąź `legacy_erp`)
a Open Mercato. Nie budujemy ERP od zera — mapujemy sortownię na moduły, które
Open Mercato już ma, przede wszystkim na **WMS**.

## Co dokładnie się mapuje

| Legacy (SIMAG / webERP) | Open Mercato | Co z tego wynika |
| --- | --- | --- |
| `locations` (`PRZYJ`, `BOKS1‑4`, `MAGRDF`) | `wms_warehouses` → `wms_warehouse_zones` → `wms_warehouse_locations` | typ lokalizacji (`staging`/`bin`) i **`capacity_weight`** — boks wreszcie ma pojemność |
| `stockmaster` (frakcje) | `catalog_products` + `catalog_product_variants` (SKU = kod odpadu) + `wms_product_inventory_profiles` | próg ponownego zamówienia, jednostka magazynowa |
| `locstock` | `wms_inventory_balances` | `on_hand` / `reserved` / `allocated` i liczona kolumna `available` |
| `stockmoves` `PZ` | komenda `wms.inventory.receive` → ruch `receipt` | |
| `stockmoves` `SORT` (**para** wierszy) | komenda `wms.inventory.move` → **jeden** ruch `transfer` | przesunięcie staje się atomowe |
| `stockmoves` `WZ` | komenda `wms.inventory.adjust` → ruch `adjust` | |
| `stkmoveno` | deterministyczny `referenceId` → `idempotency_key` WMS | powtórzony import odbija się od bazy |
| `debtorsmaster` (kontrahenci) | `customer_entities` + `customer_companies` (komenda `customers.companies.create`) | historia kontaktów, opiekun, etykiety — rzeczy, których płaska tabela nie miała gdzie trzymać |
| `salesorders` | `sales_orders` + `sales_order_lines` (komenda `sales.orders.create`) | cena za kilogram, odbiorca, wartość netto i brutto liczona przez silnik podatkowy |
| — (nie istniało) | `sales_invoices` (komenda `sales.invoices.create`) | faktura z numerem nadanym przez platformę |
| `stockmoves.orderno` | metadane ruchu WMS → `salesOrderId` | z pozycji magazynowej wchodzi się na dokument sprzedaży |
| `debtortrans` (wpłaty) | `sales_payments` + alokacje na fakturach | należności, wiek zaległości — pytanie „ile nam wiszą" ma odpowiedź |
| `stockmoves` `PZ` (dostawca) | `wms_inventory_lots` (partia) | wiadomo, **czyj** odpad leży w którym boksie |
| — (nie istniało) | `sales_shipments` jako karta przekazania | masa, kod odpadu, proces odzysku, numery rejestrowe obu stron |
| zamówienia otwarte | `wms_inventory_reservations` | magazyn nie obieca dwa razy tego samego boksu |
| `debtorsmaster.taxref` / `.bdonumber` | opis firmy w CRM / karta przekazania | NIP na fakturę, numer rejestrowy na kartę |
| `stockmaster.recoverycode` | metadane frakcji → karta przekazania | kod procesu odzysku (R1, R3, R4, R5) |

## Dwa kanały źródłowe

* **XML-RPC** (`lib/legacyRpc.ts`) — własny, minimalny klient protokołu z 1998
  roku, bez zależności. Open Mercato rozmawia ze starym systemem bezpośrednio,
  używając wyłącznie metod, które istnieją także w prawdziwym webERP.
* **Zrzut plikowy** (`lib/legacyFiles.ts`) — katalog frakcji i księga ruchów,
  czyli to, czego webERP przez API nie wystawia. Domyślnie katalog `out/`
  z tego repozytorium (`SORTOWNIA_LEGACY_OUT`).

## Instalacja w klonie Open Mercato

Turbopack nie rozwiązuje symlinków poza katalogiem projektu, więc moduł jest
**kopiowany**. Źródłem prawdy zostaje to repozytorium.

```bash
MERCATO_ROOT=/sciezka/do/open-mercato ./mercato/install.sh
cd /sciezka/do/open-mercato/apps/mercato
yarn generate          # rejestruje moduł, ACL, i18n, CLI i adapter
```

Zmienne środowiskowe (`apps/mercato/.env`):

```
SORTOWNIA_LEGACY_OUT=/sciezka/do/openmercato_garbagekind/out
SORTOWNIA_RPC_URL=http://127.0.0.1:8088/api/api_xml-rpc.php
SORTOWNIA_RPC_USER=demo
SORTOWNIA_RPC_PASSWORD=demo
SORTOWNIA_RPC_COMPANY=weberpdemo
```

## Uruchomienie

Po stronie legacy (to repozytorium):

```bash
python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
python3 legacy/server.py  --db legacy/sortownia.db --port 8088 &
python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --interval 10 &
python3 client/weberp_sync.py --wsad legacy/wsad --out out --full
```

Po stronie Open Mercato:

```bash
yarn mercato sortownia import          # topologia + frakcje + księga ruchów
yarn mercato sortownia import --limit 50
```

Import jest **idempotentny**: drugie uruchomienie na tym samym zbiorze raportuje
same duplikaty i nie dopisuje ani jednego ruchu.

## Pulpit sortowni

Ekran `/backend/sortownia` (grupa „Sortownia" w nawigacji, uprawnienie
`sortownia.view`) pokazuje to, czego stary system nie umiał powiedzieć:

* cztery kafelki: masa na placu przyjęć, masa w boksach, wysortowane i wydane
  w ostatnich 30 dniach,
* przepływ każdej frakcji przez zakład (przyjęte / wysortowane / wydane),
* listę lokalizacji z **zapełnieniem względem pojemności** — pasek robi się
  pomarańczowy od 70% i czerwony od 90%,
* frakcje z progiem wysyłki i ostrzeżeniem, gdy stan zejdzie poniżej,
* ostatnie ruchy z numerem z systemu legacy, po którym da się wrócić do kwitu;
  para `SORT` pokazuje oba numery obok siebie (`#100240 + 100241`).

Dane liczone są wprost z encji WMS przez `api/dashboard/route.ts`, więc pulpit
i magazyn zawsze mówią to samo. Pulpit odświeża się co 30 sekund.

## Panel Data Sync

`integration.ts` rejestruje system legacy jako konektor w hubie Data Sync, a
`lib/adapter.ts` dostarcza `DataSyncAdapter` z trzema typami encji
(`sortownia.topology`, `sortownia.fractions`, `sortownia.movements`), kursorem po
numerze ruchu i parametrem „przebieg próbny". Dzięki temu synchronizacja ma
kolejkę, wznawianie, historię przebiegów i pasek postępu — zamiast crona i CSV.

## Pełna ścieżka ERP

Import przechodzi kolejno, a kolejność nie jest kosmetyczna — zamówienie
potrzebuje kontrahenta i frakcji, karta przekazania potrzebuje zamówienia,
wpłata potrzebuje faktury, a rezerwacja potrzebuje stanu magazynowego:

```
topologia → frakcje → kontrahenci → zamówienia (+faktury)
          → karty przekazania → wpłaty → partie → księga ruchów → rezerwacje
```

Rezerwacje idą **po** księdze, nie przed: przed ruchami magazyn jest pusty i
WMS odmówiłby każdej, a rezerwacja założona na placu przyjęć blokowałaby masę,
która ma dopiero zostać wysortowana do boksu.

Wszystko idzie komendami platformy (`commandBus`), a nie zapisem do encji.
Komenda odpala zdarzenia, wpis do dziennika audytu i indeks wyszukiwania —
zapis na skróty dałby wiersz w bazie, którego reszta Open Mercato by nie widziała.

Zweryfikowane na żywej instancji: 8 kontrahentów, 40 zamówień, 40 faktur
(`INV-20260919-00001` … `-00040`, numery nadane przez
`salesDocumentNumberGenerator`), 152 372,18 zł netto i 187 417,79 zł brutto.

### Dwa błędy, które wyszły dopiero na żywych danych

1. **`sales.invoices.create` gubi powiązanie z zamówieniem.** Komenda przyjmuje
   `orderId`, sprawdza, że zamówienie istnieje w tym samym zakresie, a potem
   zapisuje encję przez `em.create(SalesInvoice, { orderId })`. Encja ma jednak
   wyłącznie relację `order` (`@ManyToOne`, kolumna `order_id`), więc MikroORM
   po cichu odrzuca nieznaną właściwość. Efekt: 40 faktur z pustym `order_id`.
   To błąd po stronie platformy, nie modułu — obchodzimy go `nativeUpdate` na
   relacji, z komentarzem w `lib/salesOrders.ts`.
2. **Nazwy kontrahentów są szyfrowane w spoczynku.** Odczyt `display_name`
   surowym SQL-em oddaje kryptogram (`BZhh3D8l…:v1`) i ląduje on wprost na
   ekranie operatora. Agregaty kwotowe liczymy SQL-em po identyfikatorze,
   a nazwy dociągamy `findWithDecryption`.

## Co jeszcze robi ten moduł

**Rozrachunki.** Wpłaty odbiorców idą komendą `sales.payments.create` z alokacją
na konkretną fakturę. Bez alokacji powstałaby kwota wisząca w powietrzu, której
saldo należności nie widzi. Pulpit pokazuje wystawione, wpłacone, zaległe,
liczbę niezapłaconych dokumentów i wiek najstarszego.

**Identyfikowalność.** Każde `PZ` zakłada partię (`wms.lots.create`) z nazwą
dostawcy, kodem odpadu, masą i datą przyjęcia, a ruch przyjęcia ją wskazuje.
Pytanie „czyj odpad leży w boksie trzecim" ma odpowiedź w magazynie.

WMS prowadzi saldo **osobno dla każdej partii** w lokalizacji, a `SORT` i `WZ`
w legacy mówią tylko „ile" i „skąd". Most rozkłada więc każde przesunięcie i
wydanie na partie leżące w lokalizacji źródłowej w kolejności przyjęcia (FIFO):
jeden wiersz legacy może stać się kilkoma ruchami WMS, po jednym na partię,
wszystkie z tym samym `referenceId`. Pulpit zwija je z powrotem po numerze
kwitu, a powtórzony import dolicza tylko brakującą resztę masy — nie dubluje.

**Ewidencja przekazań.** Każde zrealizowane wydanie dostaje kartę przekazania
jako wysyłkę na zamówieniu: masa w kilogramach, kod odpadu, kod procesu odzysku
i numery rejestrowe obu stron. Karta powstaje **wyłącznie** dla wydania, które
faktycznie zaszło — wystawienie jej dla odbioru zaplanowanego za tydzień byłoby
poświadczeniem zdarzenia, do którego nie doszło.

**Rezerwacje.** Zamówienie otwarte blokuje masę (`wms.inventory.reserve`), a
rezerwacja wygasa w dniu odbioru. Gdy pokrycia brak, WMS odmawia — i to jest
działająca ochrona, nie usterka; stary system przyjąłby takie zamówienie bez
słowa, a brak wyszedłby przy załadunku.

**Bilans masy.** Przyjęte minus wydane musi równać się temu, co leży.
Sortowanie jest przesunięciem wewnętrznym i masy nie zmienia, więc do bilansu
nie wchodzi. Na żywych danych bilans domyka się co do kilograma
(437 131,25 − 236 353,44 = 200 777,81 kg, różnica 0), a sprawność sortowania
wynosi 67,9%.

## Czego ten moduł NIE robi

Uczciwa lista, bo bez niej poprzednia sekcja brzmi jak obietnica:

* **brak integracji z BDO.** Karta przekazania jest *odpowiednikiem* KPO, a nie
  dokumentem z rejestru. Realna KPO powstaje w systemie prowadzonym przez
  administrację i ma numer nadany przez ten rejestr;
* **brak strony zakupowej.** Open Mercato nie ma modułu zakupów, więc przyjęcie
  odpadu jest ruchem magazynowym z partią, a nie dokumentem zakupu. Opłata
  bramowa nie jest fakturowana;
* **import jest dopisujący.** Zmiana rekordu u źródła po imporcie nie jest
  nadpisywana — jest natomiast **raportowana** jako rozjazd (wdrożone dla wpłat);
* **kwalifikacja podatkowa uproszczona.** Wszystko liczy 23% VAT. Obrót
  niektórymi odpadami bywa objęty innymi zasadami i moduł tego nie rozstrzyga;
* **jednostka wysyłki.** Wysyłki Open Mercato zakładają sztuki, więc ilość
  pozycji karty jest zaokrąglana w dół; masą wiążącą jest `weightValue`.

## Testy

Moduł korzysta z narzędzi, które Open Mercato ma na pokładzie: Jest do testów
jednostkowych i Playwright do integracyjnych (`__integration__/`, odkrywane
przez `OM_INTEGRATION_MODULES`). Nic własnego nie dokładamy.

Testy jednostkowe — 191 przypadków, 13 zestawów, bez bazy i bez sieci:

```bash
cd apps/mercato
yarn test --testPathPatterns "modules/sortownia"
```

Obejmują klienta XML-RPC (ramka żądania, ciastko sesji, kody 0/3/4/−1/−2,
`<fault>`), czytnik plików (BOM, cudzysłowy, polski przecinek dziesiętny,
determinizm `legacyUuid`), topologię, frakcje, parowanie `SORT`, mapowanie na
komendy WMS, zakładanie kontrahentów w CRM, budowę zamówień i faktur
(jednostka, cena za kilogram, VAT, idempotencja), trasę pulpitu i sam komponent
pulpitu (jsdom + Testing Library).

Cross-walidacja z legacy — porównuje odpowiedź pulpitu z księgą `out/ruchy.csv`:

```bash
# wymaga działającego stacku (Postgres, Redis, apps/mercato) i zrzutu legacy
OM_INTEGRATION_MODULES=sortownia BASE_URL=http://localhost:3000 \
  npx playwright test --config .ai/qa/tests/playwright.config.ts
```

Obie strony liczą z tej samej księgi, ale inaczej: legacy trzyma płaskie
wiersze w kilogramach, Mercato prowadzi salda w WMS i zwija parę `SORT` w jeden
`transfer`. Test sprawdza salda per lokalizacja i per frakcja, liczbę ruchów
(`reszta + pary/2`), podział plac/boksy, brak ujemnych stanów, zapełnienie
względem pojemności i to, że każdy ruch niesie numer ze starego systemu.
Po stronie sprzedaży: liczbę zamówień wobec `zamowienia.csv`, komplet faktur,
przychód netto policzony z cennika legacy co do grosza, relację brutto/netto
oraz to, że nazwy odbiorców są czytelne, a nie kryptogramem z bazy.
Jeżeli mapowanie gdzieś się przekłamie — zgubiony znak, zgubiona para, pomylona
jednostka — salda się rozjadą i ten test to pokaże.

Strona legacy ma własny zestaw (`python3 tests/test_end_to_end.py`, 19 testów),
który pilnuje m.in. tego, że stan nigdy nie schodzi poniżej zera, że powierzchnia
XML-RPC nie zawiera metod, których webERP nie ma, że NIP przechodzi kontrolę sumy
kontrolnej i że każde `WZ` wskazuje istniejące zamówienie, a `PZ` i `SORT` — nie.

## Stan na dziś

Zweryfikowane uruchomieniem na żywej instancji (Open Mercato `main` z
2026‑09‑19, Postgres 17 bez Redisa i Meilisearch — oba są opcjonalne):

* topologia: 6 lokalizacji, 3 strefy, 1 magazyn,
* frakcje: 6 pozycji katalogu z profilami zapasu,
* 8 kontrahentów, 46 zamówień, 46 faktur, 29 kart przekazania, 11 wpłat,
  80 partii, 15 rezerwacji (2 odmówione przez WMS z braku pokrycia),
* ruchy: 239 wierszy legacy → 174 operacje WMS, zero błędów, zero duplikatów
  przy ponownym imporcie,
* stany po imporcie zgodne z legacy co do kilograma we wszystkich lokalizacjach
  (np. `BOKS3` 46 593 kg), bilans masy domyka się (378 631 − 164 906 = 213 725 kg),
* WMS sam wystawił powiadomienia `wms.inventory.low_stock` dla frakcji poniżej
  progu — czyli reguła, której stary system nie miał gdzie zapisać.

Pulpit sprawdzony w przeglądarce (zalogowanie, render, zrzut ekranu): kafelki,
wykres przepływu, zapełnienie boksów i księga ruchów zasilają się z żywej bazy.

Testy: 197 jednostkowych przechodzi (także na Windows), 19 po stronie legacy.
Cross-walidacja Playwright nie była w tym przebiegu uruchamiana.

### Zmiana wymuszona przez nowszy WMS

Na bieżącym `main` saldo WMS jest koszykiem per partia. Wcześniejsza wersja
mostu przyjmowała z partią, a przesuwała i wydawała bez niej — komenda patrzyła
na pusty koszyk „bez partii" i odmawiała (`insufficient_stock`) dla 94 ze 174
operacji. Stąd rozkład na partie opisany w sekcji „Identyfikowalność" oraz
przesunięcie rezerwacji za księgę ruchów.

Nie zrobione jeszcze: uruchamianie importu z panelu Data Sync end‑to‑end
(adapter jest zarejestrowany i waliduje połączenie, ale przebiegi odpalaliśmy
komendą CLI — brakuje utworzenia rekordu integracji z poziomu panelu).

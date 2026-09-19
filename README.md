# Sortownia: Integracja ERP i Robotyki Przemysłowej (Physical AI)

System integrujący infrastrukturę sortowni odpadów z platformą Open Mercato.
Projekt łączy trzy domeny:
1. System legacy sortowni (interfejs XML-RPC w dialekcie webERP oraz zrzuty plikowe).
2. Ewidencję gospodarczo-magazynową w Open Mercato (WMS, CRM, sprzedaż, fakturowanie, KPO).
3. Warstwę wykonawczą na hali (roboty sortujące SO-101, wagi tensometryczne, kamery wizyjne i pętla uczenia maszynowego).

---

## 1. Główny schemat interakcji między komponentami (Poziom ogólny)

Architektura systemu łączy warstwę urządzeń przemysłowych, moduły sterowania robotami, most uzgadniający zapasy oraz ewidencję ERP:

```mermaid
flowchart TB
    subgraph URZADZENIA["Urzadzenia na hali"]
        ROBOT["Manipulator sortujacy SO-101"]
        WAGA["Waga tensometryczna pod pojemnikiem"]
        KAMERA["Kamery stanowiskowe"]
    end

    subgraph STEROWANIE["Warstwa Physical AI (Autonomia i bezpieczenstwo)"]
        FLEET["fleet: rejestr maszyn i kalibracji"]
        EDGE["edge: tozsamosc mTLS, sesje, heartbeat"]
        POLICY["policy_registry: wersje modeli i skroty wag"]
        SAFETY["safety: dopuszczenia celi, strefy, E-Stop"]
        DEPLOY["deployment: dzierzawy czasowe uprawnien"]
        EPISODES["episodes: rejestr trajektorii i interwencji"]
        ROLLOUT["rollout: ewaluacja metryk jakosciowych"]
        DATASETS["datasets: domknieta petla danych treningowych"]
    end

    subgraph MOST_HALA["Most Hala - ERP"]
        WO["work_orders: uzgodnienie waga vs robot"]
        VISION["vision: retencja nagran i dowody usuniecia"]
        HMI["hmi: interfejs operatora"]
        PM["physical_management: cyfrowy blizniak hali"]
    end

    subgraph SYSTEM_LEGACY["System legacy sortowni"]
        DB[("sortownia.db (SQLite)")]
        SERVER_RPC["server.py (XML-RPC)"]
        SPOOLER["spooler.py (CSV / ruchy.xlsx)"]
        SYNC_CLIENT["weberp_sync.py / adapter.ts"]
    end

    subgraph ERP_CORE["Platforma Open Mercato"]
        WMS["wms: boksy, partie FIFO, pojemnosci, rezerwacje"]
        CAT["catalog: pozycje katalogowe, kody odzysku R1-R5"]
        CRM["customers: baza kontrahentow, etapy cyklu zycia"]
        SALES["sales: zamowienia, faktury, karty przekazania KPO"]
    end

    %% Interakcje hali ze sterowaniem
    ROBOT <-->|"komunikacja agenta brzegowego"| EDGE
    ROBOT -->|"raporty wykonania chwytow"| EPISODES
    KAMERA -->|"material dowodowy"| VISION
    WAGA -->|"odczyt masy netto"| WO

    %% Przeplyw w warstwie Physical AI
    FLEET --> EDGE
    EDGE --> DEPLOY
    POLICY --> SAFETY --> DEPLOY
    DEPLOY --> EPISODES
    EPISODES --> ROLLOUT
    EPISODES --> DATASETS --> POLICY

    %% Interakcje mostu z hala i ERP
    EPISODES -->|"deklaracja liczby chwytow"| WO
    WO -->|"zaksiegowanie partii z wagi"| WMS
    WO -->|"pobranie masy nominalnej frakcji"| CAT
    WO -->|"flaga rozjazdu overclaim/underclaim"| ROLLOUT
    VISION --> PM
    WO --> PM
    HMI --> PM

    %% Interakcje legacy z ERP
    DB --> SERVER_RPC & SPOOLER
    SERVER_RPC & SPOOLER --> SYNC_CLIENT
    SYNC_CLIENT -->|"import danych historycznych"| WMS & CAT & CRM & SALES
```

---

## 2. Podsystem Legacy ERP i zasilanie bazy (Poziom średni)

### 2.1. Dwa kanały danych

Dane historyczne oraz bieżące zasilenie z instalacji legacy pobierane są dwoma torami:

```mermaid
flowchart LR
    subgraph KANAL_RPC["Kanal 1: XML-RPC (server.py)"]
        RPC_CUST["xmlrpc_GetCustomer"]
        RPC_LOC["xmlrpc_GetLocationList / Details"]
        RPC_BAL["xmlrpc_GetStockBalance"]
        RPC_SO["xmlrpc_GetSalesOrderHeader"]
    end

    subgraph KANAL_PLIKOWY["Kanal 2: Zrzut plikowy (spooler.py)"]
        FILE_CUST["kontrahenci.csv (klucze)"]
        FILE_FRAC["frakcje.csv (katalog odpadow)"]
        FILE_MOVES["ruchy.xlsx (ksiega ruchow)"]
        FILE_ORDERS["zamowienia.csv"]
        FILE_PAY["zaplaty.csv"]
    end

    subgraph ADAPTER["Klient integracyjny (adapter.ts / weberp_sync.py)"]
        PARSER["Deduplikacja i normalizacja jednostek (kg na Mg / t)"]
    end

    subgraph DOCELOWE["Moduly Open Mercato"]
        DEST_WMS["wms (lokalizacje i salda)"]
        DEST_CAT["catalog (frakcje i warianty)"]
        DEST_CRM["customers (firmy i etapy)"]
        DEST_SALES["sales (zamowienia i faktury)"]
    end

    KANAL_RPC --> PARSER
    KANAL_PLIKOWY --> PARSER
    PARSER --> DEST_WMS & DEST_CAT & DEST_CRM & DEST_SALES
```

### 2.2. Mapowanie struktur danych

| Tabela Legacy (webERP) | Encje Open Mercato | Zasada mapowania |
| --- | --- | --- |
| `locations` (`PRZYJ`, `BOKS1-4`, `MAGRDF`) | `wms_warehouses`, `wms_warehouse_zones`, `wms_warehouse_locations` | Odwzorowanie kodów na strefy (`staging`/`bin`) oraz nadanie limitów `capacity_weight` w kg. |
| `stockmaster` | `catalog_products`, `catalog_product_variants` | Kod odpadu staje się SKU wariantu; dodanie kodów procesów odzysku (R1, R3, R4, R5). |
| `locstock` | `wms_inventory_balances` | Rejestracja stanów magazynowych w rozbiciu na `on_hand`, `reserved` i `allocated`. |
| `stockmoves` (`PZ`) | `wms.inventory.receive` | Przyjęcie na plac z założeniem rekordu partii (`wms_inventory_lots`) dostawcy. |
| `stockmoves` (`SORT`) | `wms.inventory.move` | Złożenie pary wierszy legacy (rozchód z placu i przychód do boksu) w jeden atomowy ruch `transfer`. |
| `stockmoves` (`WZ`) | `wms.inventory.adjust` | Rozchód z boksu powiązany z zamówieniem sprzedaży odbiorcy. |
| `stkmoveno` | `idempotency_key` WMS | Deterministyczny `referenceId` gwarantujący brak duplikatów przy powtórnym imporcie. |
| `debtorsmaster` | `customer_entities`, `customer_companies` | Rozdział na dostawców (`DOS`) i odbiorców (`ODB`) wraz z NIP i numerem rejestrowym BDO. |
| `salesorders` | `sales_orders`, `sales_order_lines` | Pozycje zamówień z ceną jednostkową i wyliczeniem podatku VAT. |
| — | `sales_invoices` | Wystawienie faktury powiązanej z zamówieniem (`INV-...`). |
| `debtortrans` | `sales_payments` | Rozliczenia powiązane z fakturami, analiza wieku należności. |
| — | `sales_shipments` | Karta przekazania odpadu (KPO) generowana dla faktycznie zrealizowanych wydań. |

### 2.3. Sekwencja importu danych

Procedura importu zachowuje kolejność wymuszoną zależnościami relacyjnymi:

```mermaid
flowchart TD
    K1["1. Topologia (magazyn, strefy, boksy z limitami)"] --> K2["2. Frakcje (katalog odpadow i kody R)"]
    K2 --> K3["3. Kontrahenci (dostawcy i odbiorcy w CRM)"]
    K3 --> K4["4. Zamowienia i faktury sprzedazowe"]
    K4 --> K5["5. Karty przekazania odpadu (KPO) dla zrealizowanych wydan"]
    K5 --> K6["6. Wplaty i rozliczenia faktur"]
    K6 --> K7["7. Rejestracja partii dostawcow (lots)"]
    K7 --> K8["8. Ksiega ruchow magazynowych (PZ, SORT, WZ w FIFO)"]
    K8 --> K9["9. Rezerwacje stanow pod otwarte zamowienia"]
    K9 --> K10["10. Synchronizacja etapow CRM i szans sprzedazy"]
```

---

## 3. Podsystem Robotyki i Zarządzania Flotą (Physical AI)

Cykl życia modeli sterujących pracą robotów sortujących realizowany jest przez 8 modułów:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Fleet: Rejestracja maszyny i weryfikacja kalibracji
    Fleet --> Edge: Uwierzytelnienie kryptograficzne agenta
    Edge --> PolicyRegistry: Sprawdzenie wersji modelu (skrot SHA-256)
    PolicyRegistry --> Safety: Ocena dopuszczenia celi i procedur E-Stop
    Safety --> Deployment: Wydanie ograniczonej czasowo dzierzawy
    Deployment --> Episodes: Wykonanie trajektorii i zliczanie chwytow
    Episodes --> Rollout: Weryfikacja metryk skutecznosci
    Rollout --> Datasets: Agregacja danych (korekty operatorskie)
    Datasets --> PolicyRegistry: Trening nowej wersji modelu
```

* **`fleet`**: Przechowuje rejestr fizycznych ramion, parametry chwytaków, konfigurację stopni swobody (DOF) oraz daty ważności świadectw kalibracji.
* **`edge`**: Obsługuje sesje agentów brzegowych, weryfikuje tokeny tożsamości maszyn oraz monitoruje sygnały heartbeat, zamykając sesje nieaktywne.
* **`policy_registry`**: Utrzymuje wersje wag modeli sieci neuronowych identyfikowane skrótem kryptograficznym SHA-256, weryfikując zgodność wymiarów wejść/wyjść z manipulatorem.
* **`safety`**: Blokuje wydanie dzierżawy w przypadku braku certyfikacji strefy, niesprawnych barier optoelektronicznych lub wygasłej kalibracji.
* **`deployment`**: Przyznaje maszynie czasową dzierżawę zadania sortowniczego; utrata łączności unieważnia uprawnienia do kontynuowania ruchu.
* **`episodes`**: Rejestruje szczegółowe dane każdego cyklu roboczego wraz z pełnym zapisem ewentualnych przejęć sterowania przez człowieka.
* **`rollout`**: Realizuje stopniowe wdrożenia (canary deployment); bramki automatycznie cofają wdrożenie przy wzroście poślizgów materiału.
* **`datasets`**: Tworzy zbiory danych uczących z wyodrębnieniem epizodów zawierających interwencje jako danych korekcyjnych.

---

## 4. Most Hala - ERP: Uzgadnianie masy (Poziom szczegółowy)

Punkt styku telemetrii robota z księgą magazynową WMS opiera się na rozdziale deklaracji maszyny od fizycznego pomiaru:

```mermaid
flowchart TD
    subgraph POMIAR["Stanowisko sortownicze"]
        A1["Robot deklaruje: 1000 chwytow frakcji PET"]
        A2["Masa nominalna z katalogu: 30 g / szt."]
        A3["Deklarowana masa robota: 30,00 kg"]
        A4["Odczyt z legalizowanej wagi pod pojemnikiem: 24,00 kg"]
    end

    subgraph LOGIKA_MOSTU["Modul work_orders"]
        B1["Obliczenie rozjazdu: 24,00 kg - 30,00 kg = -6,00 kg"]
        B2{"Rozstrzygniecie rozjazdu"}
        B3["Werdykt: OVERCLAIM (upuszczenie sztuki lub chwyt powietrza)"]
        B4["Werdykt: UNDERCLAIM (nadmiar materialu lub blad nominalu)"]
        B5["Werdykt: Zgodnosc w granicach tolerancji"]
    end

    subgraph SKUTEK_SYSTEMOWY["Aktualizacja w systemach"]
        C1["WMS: Przyjecie na stan FAKTYCZNEJ masy 24,00 kg (wms.inventory.receive)"]
        C2["Rollout: Nalozenie flagi ostrzegawczej i obnizenie metryki robota"]
        C3["Magazyn nie blokuje surowca; flaga dotyczy oceny maszyny"]
    end

    A1 & A2 --> A3
    A3 & A4 --> B1
    B1 --> B2
    B2 -->|Waga < Deklaracja| B3
    B2 -->|Waga > Deklaracja| B4
    B2 -->|W granicach bledu| B5
    B3 --> C1 & C2 & C3
```

Obliczenia wewnętrzne mostu wykonywane są w **gramach w liczbach całkowitych**, co eliminuje błędy zmiennoprzecinkowe przy sumowaniu tysięcy operacji.

---

## 5. Przebieg operacyjny obsługi partii (Diagram sekwencji)

Poniższy diagram przedstawia przepływ danych od momentu zważenia surowca na hali do aktualizacji ewidencji magazynowej:

```mermaid
sequenceDiagram
    autonumber
    participant Robot as Manipulator SO-101
    participant Edge as Modul edge
    participant Episodes as Modul episodes
    participant Waga as Waga tensometryczna
    participant WO as Modul work_orders
    participant WMS as Modul WMS
    participant Rollout as Modul rollout

    Robot->>Edge: Heartbeat i raport stanu sesji
    Edge-->>Robot: Podtrzymanie dzierzawy zadania
    Robot->>Episodes: Rejestracja zakonczenia serii 1000 chwytow
    Operator->>Waga: Zamkniecie pojemnika i pomiar masy netto
    Waga->>WO: Przekazanie fizycznej masy (np. 24,00 kg)
    WO->>Episodes: Pobranie sumy chwytow z okna czasowego partii
    WO->>WO: Porownanie masy z wagi z deklaracja chwytow
    alt Rozjazd ujemny (Waga < Deklaracja)
        WO->>Rollout: Rejestracja zdarzenia overclaim dla maszyny
    end
    WO->>WMS: Wywolanie wms.inventory.receive z masa z wagi (24,00 kg)
    WMS-->>WO: Identyfikator utworzonej partii magazynowej
    WO->>WO: Zamkniecie zlecenia roboczego
```

---

## 6. Struktura modułów w repozytorium

```
openmercato_garbagekind/
├── legacy/                    Symulator systemu legacy sortowni (Python, stdlib)
│   ├── schema.sql             Struktura bazy danych (tabele debtorsmaster, stockmoves, etc.)
│   ├── generate.py            Generator bazy danych z powtarzalnym ziarnem
│   ├── server.py              Serwer XML-RPC obslugujacy 6 autentycznych metod webERP
│   ├── spooler.py             Cykliczny eksport katalogow i ksiegi (ruchy.xlsx)
│   ├── xlsx.py                Czytnik arkuszy Excel bez zaleznosci zewnetrznych
│   ├── sortownia.db           Baza SQLite z danymi testowymi
│   └── wsad/                  Katalog wymiany plikowej
│
├── client/                    Klient integracyjny (Python)
│   └── weberp_sync.py         Pobiera dane z XML-RPC i plikow, generuje pliki CSV
│
├── out/                       Wyniki synchronizacji gotowe do importu
│   ├── kontrahenci.csv, frakcje.csv, lokalizacje.csv, stany.csv, ruchy.csv, ...
│   └── .last_sync             Znacznik czasowy synchronizacji przyrostowej
│
├── mercato/                   Zestaw modulow platformy Open Mercato (TypeScript)
│   ├── install.sh             Skrypt instalacji modulow w glownym katalogu aplikacji
│   └── modules/
│       ├── sortownia/         Most legacy: obsluga WMS, CRM, Sales, KPO, pulpit dyrektora
│       ├── physical_management/ Cyfrowy blizniak hali i monitorowanie komorek roboczych
│       ├── fleet/             Rejestr robotow, definicje embodimentow (SO-101), kalibracja
│       ├── edge/              Agent brzegowy, tozsamosc kryptograficzna, sesje, heartbeat
│       ├── policy_registry/   Modele AI, skroty wag SHA-256, zgodnosc przestrzeni DOF
│       ├── safety/            Dopuszczenia celi, strefy bezpieczenstwa, obsluga E-Stop
│       ├── deployment/        Dzierzawy czasowe uprawnien wykonawczych
│       ├── episodes/          Ksiega trajektorii i rejestr interwencji operatora
│       ├── rollout/           Automatyczne bramki wdrazania progresywnego (canary)
│       ├── datasets/          Pętla danych uczacych i probek korekcyjnych
│       ├── work_orders/       Most hala - ERP: uzgadnianie wagi z deklaracja chwytow
│       ├── vision/            Wizja maszynowa, triangulacja, dowod retencji i kasowania nagran
│       ├── hmi/               Paleta przemyslowa i komponenty interfejsu operatora
│       └── compute/           Zarzadzanie wezlami obliczeniowymi na hali
│
├── physical-ai/               Specyfikacje i dokumentacja techniczna warstwy hali
│   ├── ROADMAP.md, README.md, ERP-BRIDGE.md, EMBODIMENTS.md, ...
│
├── webui/                     Pogladowa makieta interfejsu starego systemu
│   └── simag.html             Statyczny interfejs legacy SIMAG 3.11
│
├── tests/                     Testy integracyjne kanalu legacy (Python)
│   └── test_end_to_end.py     19 testow poprawnosci protokolu i spojnosci danych
│
└── run_demo.sh                Skrypt wykonujacy pelny przebieg demonstracyjny
```

---

## 7. Instrukcja uruchomienia i weryfikacji

Wymagania systemowe: **Python 3.11+** (wyłącznie biblioteka standardowa) oraz środowisko **Open Mercato** (Node.js, Yarn, PostgreSQL).

### 7.1. Uruchomienie demonstratora kanału legacy

Wykonanie pełnego łańcucha generator -> serwer -> spooler -> klient pełny -> klient przyrostowy:

```bash
./run_demo.sh
```

Wariant z krótszym czasem oczekiwania:

```bash
PAUSE=5 ./run_demo.sh --reserve-step 3
```

### 7.2. Uruchomienie krok po kroku

1. Inicjalizacja bazy SQLite i zrzutów początkowych:
   ```bash
   python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
   ```
2. Start serwera XML-RPC i spoolera plikowego:
   ```bash
   python3 legacy/server.py --db legacy/sortownia.db --port 8088 &
   python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --interval 5 &
   ```
   Konto testowe: użytkownik `demo`, hasło `demo`, firma `weberpdemo`.
3. Pobranie danych przez klienta synchronizującego:
   ```bash
   python3 client/weberp_sync.py --wsad legacy/wsad --out out --full
   python3 client/weberp_sync.py --out out   # kolejne uruchomienia: tryb przyrostowy
   ```
4. Instalacja modułów i wykonanie importu w Open Mercato:
   ```bash
   MERCATO_ROOT=/sciezka/do/open-mercato ./mercato/install.sh
   cd /sciezka/do/open-mercato/apps/mercato
   yarn generate
   yarn mercato sortownia import
   ```

### 7.3. Weryfikacja testami automatycznymi

* Testy modułu `sortownia`:
  ```bash
  cd apps/mercato
  yarn test --testPathPatterns "modules/sortownia"
  ```
  Zestaw 197 testów weryfikuje parser XML-RPC, parowanie wierszy SORT, dekompozycję FIFO na partie, kalkulację podatków oraz obsługę pulpitu.
* Testy modułów Physical AI:
  329 testów weryfikujących łańcuch od rejestracji robotów po generowanie zbiorów danych uczących.
* Testy integracyjne kanału legacy:
  ```bash
  python3 -m unittest discover -s tests -t . -v
  ```
  19 testów kontroluje brak ujemnych stanów, ważność ciasteczek sesyjnych, sumy kontrolne NIP oraz zgodność metod z webERP.

---

## 8. Zakres i ograniczenia systemu

* **Karty przekazania odpadu a urzędowe BDO:** Dokumenty generowane w module `sortownia` stanowią wewnętrzne odzwierciedlenie KPO powiązane z wysyłką magazynową. Moduł nie łączy się z rządowym API rejestru BDO.
* **Granice obsługi zakupów:** Przyjęcie odpadu na plac (`PZ`) stanowi operację magazynową rejestrującą partię surowca. System nie prowadzi księgi zakupowej ani fakturowania opłat bramowych od dostawców.
* **Uproszczenie podatkowe:** Sprzedaż frakcji nalicza standardową stawkę 23% VAT bez automatycznego stosowania mechanizmów podzielonej płatności lub odwrotnego obciążenia.
* **Architektura mostu hali:** Połączenie hali z ERP działa jednokierunkowo pod kątem sterowania ruchem: platforma ewidencjonuje wyniki ważenia i zamyka partie, lecz nie wysyła poleceń trajektorii bezpośrednio do kontrolerów robotów.

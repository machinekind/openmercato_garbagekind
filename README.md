# Open Mercato dla sortowni odpadów

Repozytorium zawiera demonstrator integracji systemu legacy sortowni z Open Mercato oraz moduły Physical AI dla hali sortowniczej. Projekt rozdziela ewidencję ERP od sterowania ruchem robota.

Warstwa robotyczna korzysta z danych demonstracyjnych i testów. Nie została zweryfikowana na fizycznym robocie.

## Zawartość

| Ścieżka | Rola |
| --- | --- |
| `legacy/` | Symulator webERP: SQLite, serwer XML-RPC, eksport CSV i XLSX. |
| `client/` | Klient synchronizacji Python. |
| `out/` | Pliki synchronizacji do importu. |
| `mercato/modules/` | Trzynaście modułów TypeScript dla Open Mercato. |
| `mercato/embodiments/` | Specyfikacje robotów, w tym `so101_follower.json`. |
| `physical-ai/` | Dokumentacja architektury, bezpieczeństwa i operacji. |
| `tests/` | Testy integracyjne kanału legacy. |
| `docs/architektura_sortowni_open_mercato.pptx` | Prezentacja architektury i przepływów komunikacji. |

## Architektura

```text
Urządzenia hali
robot SO-101, waga, kamery
        │
        ├── Edge: tożsamość agenta, sesje i heartbeat
        │
        └── Work orders i Vision: liczba chwytów, masa, materiał wizyjny
                    │
Physical AI ───────┼─────── Most hala – ERP ─────── Open Mercato
fleet              │        work_orders             WMS
policy_registry    │        vision                  katalog
safety             │        hmi                     CRM i sprzedaż
deployment         │
episodes           │
rollout            │
datasets           │
compute            │
```

Open Mercato ewidencjonuje wynik pracy hali. Nie wysyła poleceń trajektorii do sterowników robotów. Funkcje bezpieczeństwa pozostają poza modelem i poza węzłami ogólnego przeznaczenia.

## Moduły Open Mercato

| Moduł | Odpowiedzialność |
| --- | --- |
| `sortownia` | Import legacy, mapowanie do WMS, CRM i sprzedaży. |
| `fleet` | Rejestr robotów, embodimenty, układ hali i kalibracje. |
| `edge` | Tożsamość kryptograficzna agenta, sesje i heartbeat. |
| `policy_registry` | Wersje modeli, skróty wag i zgodność z robotem. |
| `safety` | Dopuszczenia celi, dowody bezpieczeństwa i incydenty. |
| `deployment` | Przypisania oraz dzierżawy wykonawcze. |
| `episodes` | Epizody pracy robota i interwencje operatora. |
| `rollout` | Etapy wdrożenia i bramki metryk. |
| `datasets` | Wersje zbiorów danych i przebiegi treningowe. |
| `work_orders` | Zlecenia, partie oraz uzgadnianie masy. |
| `vision` | Kamery, detektory, retencja i usuwanie materiału wizyjnego. |
| `hmi` | Komponenty interfejsu operatora. |
| `compute` | Rejestr węzłów obliczeniowych i przypisania obciążeń. |

## Komunikacja między komponentami

### Import danych legacy

1. `legacy/server.py` oferuje metody XML-RPC zgodne z powierzchnią webERP.
2. `legacy/spooler.py` publikuje katalogi i księgę ruchów jako CSV oraz XLSX.
3. `client/weberp_sync.py` pobiera dane, zachowuje cookie sesji, normalizuje jednostki i deduplikuje ruchy po `stkmoveno`.
4. Wynik trafia do `out/` jako pliki CSV.
5. Moduł `sortownia` importuje dane komendami platformy do WMS, katalogu, CRM i sprzedaży.

Klient przesuwa znacznik synchronizacji o sekundę wstecz. Dzięki temu nie gubi ruchów z tym samym czasem, a powtórki usuwa kontrola identyfikatora ruchu.

### Wykonanie pracy robota

`fleet` rejestruje robota i kalibracje. `edge` uwierzytelnia agenta oraz monitoruje łączność. `policy_registry` wskazuje wersję modelu, a `safety` sprawdza dopuszczenie celi. `deployment` przyznaje ograniczoną czasowo dzierżawę. `episodes` zapisuje wynik pracy i interwencje operatora.

`rollout` ocenia wdrożenie na podstawie metryk. `datasets` buduje wersje zbiorów z księgi epizodów i wiąże udany przebieg treningowy z wersją polityki. `compute` opisuje węzły użyte do treningu, ewaluacji lub przetwarzania danych.

### Uzgadnianie partii z WMS

1. Robot zapisuje udane chwyty w `episodes`.
2. Operator zamyka pojemnik i przekazuje masę z wagi do `work_orders` w gramach.
3. `work_orders` liczy deklarowaną masę na podstawie liczby chwytów i masy nominalnej.
4. Moduł porównuje deklarację z pomiarem i zapisuje werdykt `ok`, `overclaim` albo `underclaim`.
5. Przyjęcie do WMS korzysta z masy z wagi, niezależnie od werdyktu.
6. Wykryty rozjazd trafia jako zdarzenie do odbiorców oceniających wdrożenie.

Moduł używa szyny komend. Przy zamykaniu partii wywołuje `wms.lots.create` i `wms.inventory.receive`, zamiast zapisywać tabele magazynowe bezpośrednio.

### Zdarzenia i zadania cykliczne

Moduły emitują zdarzenia domenowe, gdy zmienia się stan. Heartbeat i odnowienie dzierżawy pozostają ruchem operacyjnym, dlatego nie tworzą zdarzenia przy każdym wywołaniu.

- `edge-sessions-sweep` wykonuje zamykanie sesji po utracie łączności.
- `fleet-calibration-expiry` ogłasza wygaśnięcie kalibracji.
- `vision-clips-purge` oznacza materiał po terminie retencji.

Szczegóły kontraktów zdarzeń zawiera [physical-ai/EVENTS.md](physical-ai/EVENTS.md), a opis operacji [physical-ai/OPERATIONS.md](physical-ai/OPERATIONS.md).

## Uruchomienie demonstratora legacy

Wymagane jest Python 3.11 lub nowszy. Kod kanału legacy używa biblioteki standardowej.

```bash
./run_demo.sh
```

Wariant ręczny:

```bash
python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
python3 legacy/server.py --db legacy/sortownia.db --port 8088
python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --interval 5
python3 client/weberp_sync.py --wsad legacy/wsad --out out --full
```

Konto demonstracyjne: `demo` / `demo`, firma `weberpdemo`.

## Instalacja modułów w Open Mercato

```bash
MERCATO_ROOT=/sciezka/do/open-mercato ./mercato/install.sh
cd /sciezka/do/open-mercato/apps/mercato
yarn generate
yarn mercato db migrate
yarn mercato auth sync-role-acls
```

Po instalacji modułów należy zarejestrować harmonogramy i widgety zgodnie z [physical-ai/OPERATIONS.md](physical-ai/OPERATIONS.md).

## Testy

```bash
python3 -m unittest discover -s tests -t . -v
```

Testy modułów Open Mercato uruchamia się w klonie platformy:

```bash
cd apps/mercato
yarn test --testPathPatterns "modules/(fleet|edge|policy_registry|safety|deployment|episodes|rollout|datasets|work_orders|vision|compute)"
```

## Dokumentacja techniczna

- [Mapa faz](physical-ai/ROADMAP.md)
- [Most hala – ERP](physical-ai/ERP-BRIDGE.md)
- [Specyfikacje robotów](physical-ai/EMBODIMENTS.md)
- [Wizja maszynowa](physical-ai/VISION.md)
- [Węzły obliczeniowe](physical-ai/COMPUTE.md)
- [Interfejs operatora](physical-ai/HMI.md)
- [Katalog zdarzeń](physical-ai/EVENTS.md)
- [Rzut hali](physical-ai/PLANT-VIEW.md)
- [Zadania cykliczne i kroki instalacyjne](physical-ai/OPERATIONS.md)
- [Zadania dla zespołu physical](physical-ai/HANDOFF-PHYSICAL.md)

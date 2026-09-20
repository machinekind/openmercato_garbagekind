# Zdarzenia modułowe

Do tej wersji wtyczka była systemem, który wszystko **zapisywał** i nic nie
**ogłaszał**. Robot wjeżdżał do kwarantanny, kalibracja traciła ważność, partia
rozjeżdżała się z wagą - i nie istniał sposób, żeby cokolwiek w systemie na to
zareagowało inaczej niż przez otwarcie właściwego ekranu przez właściwą osobę
we właściwej chwili.

Ten dokument opisuje, co ogłaszamy, czego świadomie nie ogłaszamy i dlaczego.

## Zasada doboru

**Zdarzenie deklarujemy wyłącznie wtedy, gdy je faktycznie emitujemy.**

Zdarzenie zadeklarowane, a nigdy nieemitowane, jest gorsze niż jego brak:
pojawia się na liście wyzwalaczy workflow w interfejsie, ktoś zbuduje na nim
automatyzację i dowie się, że nie działa, dopiero w dniu, w którym miała
zadziałać. Dlatego w `events.ts` każdego modułu nie ma ani jednej pozycji bez
odpowiadającego jej wywołania `emit` w kodzie.

Z tej samej zasady wynika, czego tu nie ma:

- **`hmi`** nie ma `events.ts`. To biblioteka wzorników wizualnych - nie ma
  stanu, nie ma komend, nie ma czego ogłaszać. Pusty plik byłby kultem cargo.
- **`sortownia`** nie ma `events.ts`. Nie ma własnych komend; działa na
  komendach rdzenia (`wms.*`, `sales.*`), a te emitują własne zdarzenia.

## Zdarzenie a dziennik audytu

Szyna komend już zapisuje każdą operację razem z aktorem i stanem przed/po.
Zdarzenia **nie są** drugim dziennikiem i nie mają lustrzanie odbijać CRUD-u.
Odpowiadają na inne pytanie: *co musi się teraz stać gdzie indziej*.

Praktyczny skutek: nieudana próba nie emituje. Odmowa nadania węzłowi roli
funkcji bezpieczeństwa, odmowa zatwierdzenia uzasadnienia deklarującego uczoną
politykę jako funkcję bezpieczeństwa, odmowa domknięcia przebiegu treningowego
bez wskazanej polityki - wszystkie wracają wyjątkiem do wołającego i lądują
w dzienniku audytu. Żadna z nich nie zmieniła stanu świata, więc nie ma czego
ogłaszać.

## Trzy reguły częstotliwości

Wtyczka obsługuje ruch o częstotliwości maszynowej, więc dobór zdarzeń musi się
z tym liczyć. Strumień, w którym tonie wszystko istotne, jest gorszy niż brak
strumienia - bo wygląda jak działający monitoring.

### 1. Ruch nie jest faktem

Świadomie **nie emitujemy**:

| Co | Częstotliwość | Dlaczego nie |
|---|---|---|
| `edge` - uderzenie serca | ~1/s × flota | Faktem jest dopiero jego **brak** (`edge.agent.lost`) |
| `deployment` - wydanie dzierżawy | ~1/30 s × flota | Odnowienie mandatu jest ruchem, nie zmianą |
| `deployment` - raport stanu | ~1/30 s × flota | Faktem jest **zmiana werdyktu**, nie nadejście raportu |
| `safety` - sprawdzenie dopuszczenia | przy każdym przypisaniu | To jest pytanie, nie fakt; odmowa jest jego normalną odpowiedzią |

### 2. Wyzwalanie zboczem

`deployment.state.drift_detected` i `deployment.state.converged` porównują
werdykt bieżącego raportu z werdyktem **poprzedniego raportu tej samej
maszyny**. Rozjazd trwa tyle, ile trwa jego przyczyna; ogłaszanie go przy
każdym raporcie dałoby to samo zdarzenie co pół minuty przez cały czas awarii.

`null` jako poprzedni werdykt (pierwszy raport maszyny) liczy się jako zmiana -
bo nią jest.

Test `deployment/__tests__/events.test.ts` pilnuje właśnie tego, bo ta reguła
psuje się cicho: usunięcie porównania niczego nie wywala, tylko zamienia
zdarzenie w szum.

### 3. Odhaczanie w danych

`fleet.calibration.expired` jest ogłaszane **raz na kalibrację**, a odhaczenie
siedzi w kolumnie `fleet_calibrations.expiry_notified_at`.

Kolumna nie mówi „kalibracja wygasła" - ważność nadal wyprowadzamy przy odczycie
z `valid_until`, bo stan wyliczony nie potrafi rozjechać się z faktem. Mówi
„ten fakt został już raz ogłoszony". Bez tego detektor godzinny nadawałby to
samo co przebieg.

### Jeden świadomy wyjątek

`vision.clips.deletion_overdue` **powtarza się przy każdym przebiegu**, dopóki
stan trwa. To nie jest niedopatrzenie: „dziś nadal przechowujemy nagranie po
terminie z art. 22² § 3 Kodeksu pracy" jest prawdziwe każdego dnia z osobna
i każdego dnia z osobna jest naruszeniem. Ogłoszenie raz i zamilknięcie
zamieniłoby trwające naruszenie w jednorazową notkę.

## Zdarzenia wyróżnione obok ogólnych

Kilka faktów ma dwa zdarzenia naraz: ogólne i wyróżnione. To nie jest
duplikacja przez pomyłkę - to ten sam wzorzec, którego używa rdzeń (`wms`
emituje i `inventory_balance.updated`, i `inventory.low_stock`).

Kryterium: **wyróżniamy wtedy, gdy odbiorca jest inny**. Subskrybent, który ma
wstrzymać przydział pracy maszynie, nie powinien dopasowywać stringa w polu
`toState`; kanał alarmowy nie powinien filtrować `decision === 'rollback'`
i budzić dyżurnego przy każdym pomyślnym przejściu, dopóki ktoś tego filtru nie
napisze poprawnie.

| Ogólne | Wyróżnione | Odbiorca wyróżnionego |
|---|---|---|
| `fleet.robot.transitioned` | `.quarantined`, `.cleared`, `.decommissioned` | wstrzymanie pracy / wznowienie / unieważnienie tożsamości brzegowej |
| `policy_registry.version.transitioned` | `.released`, `.deprecated` | dopuszczenie do przypisania / przegląd maszyn z tą wersją |
| `episodes.intervention.recorded` | `.emergency` | odebranie maszynie sprawczości (`estop`, `abort`, `teleop_takeover`) |
| `safety.run.recorded` | `.failed` | brak dowodu zgodności |
| `safety.incident.reported` | `.halted_deployment` | hurtowe wycofanie dopuszczenia dla klasy celi |
| `work_orders.batch.closed` | `.drift_detected` | skierowanie człowieka do robota |
| `vision.camera.registered` | `.compliance_warning` | usunięcie braków formalnych przed uruchomieniem |

Dwa dobory nazw warte odnotowania:

- **`edge.agent.clone_suspected`**, nie `clone_detected`. Wyparcie żywej sesji
  robi tak samo zwykły restart maszyny, jak druga kopia agenta z tym samym
  kluczem. Pojedyncze zdarzenie nie rozstrzyga niczego - rozstrzyga ciąg wyparć
  w krótkim czasie, i dlatego ładunek niesie liczbę uderzeń serca wypartej sesji
  oraz jej ciszę w chwili wyparcia. Nazwa `detected` kazałaby odbiorcy uwierzyć
  w pewność, której nie mamy.
- **`safety.run.failed` obejmuje `error`**, nie tylko `fail`. Zestaw, który się
  wywrócił, nie wykazał zgodności - tak samo jak zestaw oblany. Rozdzielenie ich
  zachęcałoby do traktowania awarii potoku jako „jeszcze nie porażki", a to jest
  nawyk, który kończy się polityką dopuszczoną bez dowodu.

## Ładunki są typowane

Każde zdarzenie niesie `payloadSchema` - płaską listę ścieżek i typów, z której
edytor workflow buduje wybór pól. Rdzeń generuje taki schemat automatycznie dla
zdarzeń CRUD i pozostawia go pustym dla własnych; my deklarujemy go wszędzie,
bo zdarzenie bez opisanego ładunku daje autorowi automatyzacji wybór „zrób coś,
gdy to padnie" i nic więcej.

Kilka pól jest w ładunku z rozmysłem, a nie dla kompletności:

- `work_orders.batch.closed` niesie werdykt **także gdy brzmi `ok`** -
  statystyka dryfu potrzebuje mianownika, nie tylko licznika.
- `work_orders.batch.drift_detected` jest wyzwalane **werdyktem**, nie flagą
  `requiresReview`. Flaga jest decyzją o skierowaniu maszyny do przeglądu i może
  być wyciszona progiem; werdykt jest tym, co zmierzono.
- `rollout.stage.started` niesie liczbę maszyn **pominiętych**. Etap,
  w którym pominięto połowę floty, ma w statusie to samo słowo `running`, co
  etap udany.
- `datasets.version.built` niesie ostrzeżenia o składzie, nie sam licznik.
  Zbiór z samych udanych epizodów ma ten sam `episodeCount` co zbiór
  zrównoważony i jest bezużyteczny do uczenia odzyskiwania po błędzie.
- `compute.node.registered` niesie przepustowość pamięci. To ona, a nie liczba
  operacji zmiennoprzecinkowych z materiałów producenta, rozstrzyga
  o przepustowości dekodowania.

## Granice modułów zostają

Zdarzenia nie są furtką do obejścia decyzji projektowych.

`edge` stwierdza ciszę i ogłasza `edge.agent.lost`. **Nie** wstawia robota do
kwarantanny - wniosek „cisza znaczy: nie wolno pracować" należy do dziedziny
i zapada w `fleet`. Tak samo detektor wygasłych kalibracji ogłasza fakt i nie
zatrzymuje maszyn: detektor, który sam zatrzymuje, po pierwszym fałszywym
alarmie zostaje wyłączony - i wtedy nie ogłasza już niczego.

## Katalog

59 zdarzeń w 11 modułach.

| Moduł | Zdarzenia |
|---|---|
| `fleet` | `robot.registered`, `robot.transitioned`, `robot.quarantined`, `robot.cleared`, `robot.decommissioned`, `calibration.recorded`, `calibration.expired`, `cell.layout_changed` |
| `edge` | `enrollment.issued`, `agent.enrolled`, `agent.connected`, `agent.clone_suspected`, `agent.lost`, `agent.key_rotated`, `agent.revoked` |
| `policy_registry` | `policy.registered`, `version.registered`, `version.transitioned`, `version.released`, `version.deprecated` |
| `deployment` | `assignment.assigned`, `assignment.revoked`, `state.drift_detected`, `state.converged` |
| `episodes` | `episode.recorded`, `intervention.recorded`, `intervention.emergency`, `counts.corrected` |
| `rollout` | `rollout.planned`, `stage.started`, `gate.advanced`, `gate.held`, `gate.rolled_back` |
| `safety` | `case.drafted`, `case.approved`, `case.withdrawn`, `suite.defined`, `run.recorded`, `run.failed`, `incident.reported`, `incident.halted_deployment` |
| `datasets` | `dataset.defined`, `version.built`, `run.registered`, `run.completed` |
| `work_orders` | `order.opened`, `order.closed`, `batch.opened`, `batch.closed`, `batch.drift_detected` |
| `vision` | `camera.registered`, `camera.compliance_warning`, `detector.registered`, `window.recorded`, `clips.marked_for_deletion`, `clips.deletion_confirmed`, `clips.deletion_overdue` |
| `compute` | `node.registered`, `placement.set` |

Pełna lista z ładunkami jest dostępna w działającej aplikacji pod
`GET /api/events?module=fleet` (wymaga uprawnienia `workflows.view`) i to samo
źródło zasila wybór wyzwalaczy w edytorze workflow.

## Detektor wygasłych kalibracji

Przy okazji tej zmiany powstało zadanie cykliczne, którego wcześniej nie było -
bo „wygasła kalibracja" była faktem, który system potrafił policzyć i nie
potrafił nikomu powiedzieć.

```
mercato fleet install-schedules   # rejestracja harmonogramu (co godzinę)
mercato fleet expiry              # ręczny przebieg, ten sam co cykliczny
```

Kolejka: `fleet-calibration-expiry`. Komenda: `fleet.calibrations.detect_expired`.
Migracja `Migration20260919233000_fleet_calibration_expiry` dokłada kolumnę
`expiry_notified_at` i indeks częściowy po `valid_until` dla wierszy jeszcze
nieogłoszonych.

Ładunek rozróżnia pomiar **wymagany** przez rewizję embodimentu od pomiaru
spoza listy wymaganych: pierwszy blokuje dopuszczenie maszyny, drugi jest
informacją dla serwisu.

## Nauczka: plik z komendami nie jest biblioteką

Ta zmiana odsłoniła defekt, który siedział w module `fleet` od początku
i nie dawał się zauważyć.

`fleet/cli.ts` importował `evaluateRobotCalibration` z `commands/robots.ts`.
Plik z komendami rejestruje je efektem ubocznym importu, więc jego statyczny
import z wiersza poleceń w zestawieniu z leniwym importem tego samego pliku
przez ładowarkę szyny dawał `Duplicate command registration for id
fleet.robots.register`.

Nie wychodziło to nigdy, bo **żadna komenda wiersza poleceń modułu `fleet` nie
sięgała wcześniej do szyny komend**. Pierwsza, która sięgnęła - `fleet expiry` -
wywróciła się natychmiast.

Funkcja mieszka teraz w `fleet/lib/robotCalibration.ts`. Reguła ogólna:
cokolwiek ma być wołane spoza szyny, mieszka w `lib/`.

## Testy

Każdy moduł ma `__tests__/events.test.ts` sprawdzający reguły nieoczywiste -
te, które psują się cicho i w dobrą stronę:

- podwójna emisja przy kwarantannie i brak wyróżnionego zdarzenia przy
  przejściu do serwisu,
- idempotencja detektora wygasłych kalibracji, w tym odhaczanie kalibracji po
  usuniętym robocie **bez** ogłaszania jej (alarm bez adresata),
- wyzwalanie zboczem: drugi raport tego samego rozjazdu milczy, powrót do
  zgodności nie,
- brak emisji na każdej ścieżce deduplikacji (dosłany epizod, ponownie wgrana
  wersja polityki, powtórzone okno detekcji, przebudowa zbioru z tych samych
  kryteriów),
- `error` w przebiegu ewaluacyjnym traktowany jak `fail`,
- incydent bez wskazanej wersji polityki **nie** ogłasza wycofania dopuszczenia,
  bo niczego nie wycofał,
- nieudana próba nadania roli bezpieczeństwa nie emituje niczego.

## Dowód

**Rejestr w działającej aplikacji** (`GET /api/events?module=…`, zalogowana sesja):

```
fleet: 8 zdarzeń, 8 z opisanym ładunkiem
edge: 7 / 7
policy_registry: 5 / 5
deployment: 4 / 4
episodes: 4 / 4
rollout: 5 / 5
safety: 8 / 8
datasets: 4 / 4
work_orders: 5 / 5
vision: 7 / 7
compute: 2 / 2
```

Wszystkich zdarzeń w systemie po dołożeniu naszych: **547**.

**Detektor wygasłych kalibracji na realnych danych** - dwa przebiegi pod rząd
na tym samym stanie bazy:

```
$ mercato fleet expiry
Ogłoszono wygaśnięcie: 2
  ab40903c-…  camera_extrinsics  do 2026-09-17T10:36:36Z  [operational] WYMAGANA
  ab40903c-…  tool_center_point  do 2026-09-17T10:36:36Z  [operational] WYMAGANA

$ mercato fleet expiry
Brak nowo wygasłych kalibracji.
Uwaga: to nie znaczy „wszystkie ważne" - znaczy „nic nowego do ogłoszenia".
```

Idempotencja potwierdzona na prawdziwych wierszach, nie tylko na atrapie
w testach.

**Emisja przez realną szynę, nie przez atrapę.** Agentowi ustawiono „ostatnio
widziany" dwie godziny wstecz; harmonogram `edge-sessions-sweep` w działającym
serwerze wykonał przebieg o `10:42:42`, zamknął sesję (otwartych: 1 → 0)
i wyemitował `edge.agent.lost`. W dzienniku serwera **zero** ostrzeżeń
`Event bus not available` - czyli emisja trafiła na uzbrojoną szynę, a nie
w pustkę.

Uczciwa granica tego dowodu: nie ma jeszcze żadnego subskrybenta, więc pełny
obieg „zdarzenie → reakcja" nie jest obserwowalny. Potwierdzone jest, że
zdarzenie powstaje, jest zadeklarowane i dociera do szyny.

**Testy**: 1314 przechodzi, w tym 11 nowych zestawów emisji.
**Typecheck**: `tsc --noEmit` czysty poza sześcioma wcześniejszymi błędami
w `sortownia`, niezwiązanymi z tą zmianą.

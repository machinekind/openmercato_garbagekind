# Physical AI - wdrażanie robotów uczonych RL

> **Dowody sprzętowe z hackathonu (18-19.09.2026):** raporty, notatki sesyjne,
> skrypty diagnostyczne i manifest pochodzenia z repozytorium `mercatoXD` są
> zachowane w [`evidence/hackathon-2026-09-18-19/mercatoXD/`](evidence/hackathon-2026-09-18-19/mercatoXD/README.md).
> Materiał dotyczy głównie Galaxea A1X/A1XY; nie zastępuje odbioru SO-101.

Aktualna lista prób i artefaktów do zebrania przez zespół physical:
[`PHYSICAL-VALIDATION-BACKLOG.md`](PHYSICAL-VALIDATION-BACKLOG.md).
Ostatni zweryfikowany stan programu i jawne blokady sprzętowe:
[`VERIFICATION-STATUS.md`](VERIFICATION-STATUS.md).
Kontrakt paczki dowodowej i jej kontrola integralności:
[`EVIDENCE-BUNDLE.md`](EVIDENCE-BUNDLE.md).
Inwentaryzacja materiału `mercatoXD` - co domyka nasze bramy, a co zostaje
otwarte: [`MATERIAL-MERCATOXD.md`](MATERIAL-MERCATOXD.md).
Procedura odbioru podłączonego SO-101 znajduje się w
[`mercato/hardware/so101/README.md`](../mercato/hardware/so101/README.md).

Ten katalog jest miejscem na nowy kierunek: platformę operacyjną dla flot
robotów, których polityki sterowania uczone są metodami RL (oraz IL, offline
RL i modelami VLA).

Pełny raport rozpoznawczy - literatura, dekompozycja produktu i ocena
Open Mercato jako fundamentu - powstał jako dokument:

**https://claude.ai/code/artifact/b4a907ca-74b7-4740-91f0-87a162172da7**

## Teza organizująca

Platforma nie steruje robotem i nie uczy polityki. Jej praca to wiązanie
wersji polityki z populacją robotów pod zatwierdzonym uzasadnieniem
bezpieczeństwa i prowadzenie audytowalnego zapisu tego, co gdzie działało,
co zrobiło i kto interweniował.

## Trzy warunki, pod którymi Open Mercato jest właściwym fundamentem

1. Moduły `catalog` / `sales` / `wms` / `checkout` / `warranty_claims`
   zostają wyłączone i nigdy nie stają się zależnością modułu robotycznego.
2. Kotwicą modelu robota jest `resources` (zależy tylko od `planner`),
   nie `catalog`.
3. Granica control plane / data plane zapisana w ADR w tygodniu pierwszym
   i egzekwowana w code review: żaden przepływ telemetrii, żaden artefakt
   binarny i żaden strumień teleoperacji nie przechodzi przez szynę komend
   ani przez MikroORM.

Upadek któregokolwiek warunku odwraca rekomendację.

## Konsekwencja regulacyjna, która wyprzedza wszystkie architektoniczne

Uczona polityka nie może być funkcją bezpieczeństwa. Umieszczenie jej
w łańcuchu bezpieczeństwa wpycha produkt klienta w Annex I część A
rozporządzenia (UE) 2023/1230 (stosowanego od 20 stycznia 2027), czyli
w obowiązkową ocenę przez jednostkę notyfikowaną - dla której nie istnieje
ustalona metoda wykazania zgodności.

Bezpieczeństwo egzekwuje osobna, deterministyczna, certyfikowalna warstwa.
Platforma ma to wymuszać i dokumentować.

## Rozstrzygnięcia przed fazą 0

| Pytanie | Decyzja | Konsekwencja w kodzie |
| --- | --- | --- |
| Struktura własności | właściciel + integrator | `owner_organization_id` i `operator_organization_id` rozdzielone w `fleet_robots` od pierwszej migracji |
| Klasa robotów | manipulatory stacjonarne | epizod jest naturalnym atomem; ryzyko R1 nie dotyczy tego wdrożenia |
| Opóźnienie halt-to-stop | sekundy, cele ogrodzone | halt może iść z centrali przez bramy; `risk_class = fenced` daje dzierżawę w dniach |

## Stan implementacji

**Faza 0 - moduł `fleet`** (w `mercato/modules/fleet`): rejestr robotów, klas
sprzętowych, obiektów, cel i kalibracji. Sześć tabel, trzy komendy, strona
backendu, dwie komendy CLI, 47 testów jednostkowych.

Uruchomienie:

```bash
./mercato/install.sh fleet
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls   # nadaje uprawnienia fleet.* rolom
yarn mercato fleet seed            # flota demonstracyjna
yarn mercato fleet status          # rejestr kontra hala
```

Ekran: `/backend/fleet`, uprawnienie `fleet.view`.

**Faza 0 - moduł `edge`** (w `mercato/modules/edge`): tożsamość kryptograficzna
agenta na robocie, sesje łączności i uderzenia serca. Cztery tabele, siedem
komend, trzy endpointy agenta, dwa endpointy panelu, strona backendu, cztery
komendy CLI, 48 testów jednostkowych.

Moduł jest celowo ubogi semantycznie i ma taki zostać. Odpowiada na dwa pytania
i żadne inne: **czy ten, kto się odzywa, jest tym, za kogo się podaje** i
**kiedy odezwał się ostatnio**. Jeśli pojawi się tu potrzeba dołożenia pola
`policy_version_id` albo czegokolwiek o treści pracy robota, modelowanie poszło
złą drogą.

Rozstrzygnięcia warte wypisania, bo każde z nich miało kuszącą i gorszą
alternatywę:

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Żywotność liczona z `last_seen_at` przy odczycie | kolumna `online boolean` gaszona zadaniem cyklicznym | zadanie, które padnie, zostawia całą flotę na ekranie jako „online" - pulpit kłamie najgłośniej wtedy, kiedy najbardziej trzeba mu wierzyć |
| Heartbeat podpisany kluczem Ed25519 | deklaracja „jestem agentem X" | bez podpisu każdy, kto zna identyfikator, utrzyma martwego robota przy życiu na pulpicie |
| W bazie tylko skrót biletu wpisowego | bilet w jawnej postaci | bilet odczytywalny z tabeli jest kluczem do floty leżącym obok floty |
| Rotacja z oknem zakładkowym | natychmiastowe odwołanie starego klucza | inaczej każda rotacja jest zaplanowanym zerwaniem łączności z całą flotą naraz |
| Licznik kolejny per **sesja** | licznik globalny per agent | agent po restarcie zaczyna od nowa; licznik globalny odrzucałby każdy legalny restart jako powtórkę |
| `sweep` zwraca listę utraconych, nie kwarantannuje | automatyczna kwarantanna | „cisza znaczy: nie wolno pracować" to wniosek dziedzinowy - zapada w `fleet`, nie w kanale |

Rozdział `edge` od `fleet` nie jest estetyczny: robot trwa dziesięć lat, klucz
rotuje się co kwartał, a komputer pokładowy bywa wymieniany bez zmiany maszyny.
Kierunek zależności jest jednostronny - `edge` zna kolumnę `robot_id`, `fleet`
nie wie o agencie. Pulpit floty składa oba źródła po stronie przeglądarki, więc
rejestr działa również tam, gdzie kanału brzegowego nie ma wcale.

Uruchomienie:

```bash
./mercato/install.sh edge
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato edge issue --robot UR10E-0001    # bilet wpisowy, jawny raz
yarn mercato edge simulate --robot UR10E-0001 # agent z prawdziwą parą kluczy
yarn mercato edge status
yarn mercato edge sweep                       # zamyka sesje po progu ciszy
```

Ekran: `/backend/edge`, uprawnienie `edge.view`. Stan łączności pojawia się też
w rejestrze floty na `/backend/fleet`.

`simulate` nie jest atrapą: generuje prawdziwą parę Ed25519, podpisuje
prawdziwe komunikaty i przechodzi tę samą ścieżkę uwierzytelnienia, co agent na
robocie. Symulacja omijająca podpis dowodziłaby wyłącznie tego, że da się
napisać symulację.

### Dowód fazy 0

Warunek zaliczenia brzmiał: *agent rejestruje się, bije heartbeat, a po
odcięciu zasilania robot znika z pulpitu w zdefiniowanym czasie*. Przebieg na
żywej instancji, progi skrócone do sekund, żeby dało się go obejrzeć:

```
Progi     : odstęp 3s, tolerancja 4s, utrata po 25s
  #1 online  termin 04:52:59
  #2 online  termin 04:53:02
po ~0s ciszy: UR10E-0002  enrolled  online   cisza=6s
po ~6s ciszy: UR10E-0002  enrolled  late     cisza=18s
po ~20s ciszy: UR10E-0002 enrolled  lost     cisza=44s
--- sweep:
Zamknięto sesji po ciszy: 1
  utracony: UR10E-0002 - cisza 51s
```

Między drugim a trzecim odczytem nic nie zostało zapisane - cisza po prostu
upłynęła, a stan wynika z odczytu, nie z czyjegoś zapisu. To jest cała różnica
między tym rozwiązaniem a flagą `online` w tabeli.

Druga połowa dowodu to ścieżka sieciowa: klient bez żadnej sesji platformy,
z własną parą Ed25519, przechodzi wpis i uderzenia serca po HTTP, a trzy próby
nadużycia odbijają się na tym samym poziomie:

```
enroll     : 200  {"agentId":"62204b06…","sessionId":"154cb69f…"}
heartbeat #1: 200 online
heartbeat #2: 200 online
powtórka   : 401  Numer kolejny 2 nie jest większy od ostatniego (2) - powtórka lub klon.
obcy klucz : 401  Podpis nie zgadza się z żadnym ważnym kluczem agenta.
bilet 2x   : 401  Bilet wpisowy nieważny lub już zużyty.
```

Endpointy agenta (`/api/edge/enroll`, `/api/edge/connect`, `/api/edge/heartbeat`)
są jedynymi w systemie bez wymogu sesji użytkownika. To świadome odstępstwo
dotyczące **mechanizmu**, nie rygoru: agent na robocie nie jest człowiekiem
i nie ma się jak zalogować, więc uwierzytelnia się podpisem kluczem, którego
centrala nie posiada. Odpowiedź heartbeatu niesie stan łączności i następny
termin - i nic poza tym; stan pożądany oprogramowania jest osobnym kanałem
i sklejenie go tutaj zrobiłoby z żywotności warunek wdrożenia.

---

**Faza 1 - moduł `policy_registry`** (w `mercato/modules/policy_registry`):
wersjonowany rejestr wyuczonych sterowników. Cztery tabele, trzy komendy,
endpoint panelu, strona backendu, trzy komendy CLI, 41 testów jednostkowych.

Moduł odpowiada na dwa pytania i żadne inne: **co to za polityka** i **na czym
wolno ją uruchomić**. Nie ma tu wdrożenia, stanu pożądanego ani wyników
ewaluacji. Gdyby pojawiło się tu pole `robot_id`, modelowanie poszłoby złą
drogą - polityka wiąże się z kontraktem sprzętu, nie z egzemplarzem.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Tożsamością wersji jest skrót kompletu artefaktów | numer nadawany przy każdym wgraniu | dwa wgrania tych samych wag to jedna polityka; dwa rekordy unieważniają każdą statystykę liczoną per wersja, a na tych statystykach stoi brama fazy 4 |
| Powtórka zwraca istniejącą wersję z flagą `deduplicated` | rzucenie wyjątku | wyjątek zmusiłby każdy potok CI do odróżniania „wgrałem to już" od awarii i skończyłby się połknięciem obu |
| `uri` i rozmiar **nie** wchodzą do skrótu treści | skrót po adresie w magazynie | migracja magazynu obiektów rozmnożyłaby całą historię wersji bez zmiany jednego bitu wag |
| Unikat `(tenant, policy, content_digest)` w bazie | deduplikacja wyłącznie w kodzie komendy | dwa równoległe potoki CI wgrałyby ten sam model dwa razy i nikt by tego nie zauważył |
| Odcisk kontraktu **deklarowany** przez wgrywającego | odczytany z rejestru floty przy rejestracji | odczytana wartość porównywałaby się sama ze sobą i kontrola zawsze by przechodziła; rozjazd wychodzi tylko wtedy, gdy obie strony mówią niezależnie |
| Kopia `spec_digest` zapisana przy wersji | wyłącznie klucz obcy do rewizji | „teoretycznie niezmienna rewizja" to za mało dla zapisu, który ma odpowiedzieć regulatorowi po trzech latach |
| Odczyt rewizji surowym SQL-em | import klasy encji z modułu `fleet` | jedna klasa zarejestrowana pod dwiema ścieżkami to gwarantowane „Metadata for entity X not found" |
| `policy_registry.release` osobno od `manage` | jedno uprawnienie na moduł | wgranie wag jest czynnością techniczną, wypuszczenie ich na flotę - decyzją o dopuszczeniu maszyny do ruchu |
| Brak pola „zatwierdzona" na wersji | globalna flaga dopuszczenia | dopuszczenie jest funkcją pary (wersja, klasa celi) i mieszka w `safety`; flaga globalna każe pisać uzasadnienie dla każdej celi z osobna |
| W tabeli adres i skrót artefaktu | bajty wag w kolumnie | warunek trzeci raportu: żaden artefakt binarny nie przechodzi przez MikroORM ani przez szynę komend |

Uruchomienie:

```bash
./mercato/install.sh policy_registry
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato fleet seed                     # rewizje embodimentu muszą istnieć wcześniej
yarn mercato policy_registry seed
yarn mercato policy_registry status
yarn mercato policy_registry prove          # dowód fazy
```

Ekran: `/backend/policies`, uprawnienie `policy_registry.view`.

### Dowód fazy 1

Warunek zaliczenia brzmiał: *próba zarejestrowania wersji dla embodimentu
o innym `spec_digest` odbija się z nazwanym powodem; powtórne wgranie tych
samych wag nie tworzy drugiej wersji.* Przebieg na żywej instancji:

```
DOWÓD FAZY 1 - rejestr polityk

1) ta sama rewizja, ale polityka uczona pod innym odciskiem kontraktu
   odbite: Nie można zarejestrować wersji [spec_digest_mismatch]: odcisk kontraktu
   embodimentu nie zgadza się: rewizja ur10e-pick@r1 ma demo:ur10e-pick:r1,
   a polityka była uczona pod demo:ur10e-pick:r999-inny-kontrakt.

2) rewizja z innej rodziny sprzętu
   odbite: Nie można zarejestrować wersji [embodiment_key_mismatch]: polityka jest
   dla rodziny ur10e-pick, a wskazana rewizja należy do fr3-assembly.

3) powtórne wgranie tych samych wag pod właściwą rewizję
   zwrócono v1 deduplicated=true; wersji przed 2, po 2
```

Komunikat odmowy niesie **obie** wartości odcisku, nie tylko kod błędu - bez
tego operator nie wie, którą stronę poprawić. Trzeci punkt jest ważniejszy, niż
wygląda: licznik wersji nie drgnął, mimo że komenda wykonała się normalnie
i zwróciła identyfikator. To jest różnica między rejestrem a katalogiem plików.

Druga połowa dowodu to ścieżka sieciowa - konto `employee` ma `policy_registry.view`
i `policy_registry.manage`, ale nie `release`:

```
GET /api/policy_registry/policies  →  200
totals: {"policies": 2, "versions": 3, "released": 0, "deprecated": 0,
         "embodimentDrift": 0, "orphanedEmbodiment": 0}
insert-peg-fr3 fr3-assembly [(1, '50da1b1fe566', 'fr3-assembly@r1', 'registered', ['config','weights'])]
pick-bin-ur10e ur10e-pick   [(2, '137069a4929b', 'ur10e-pick@r1', 'registered', ['config','weights']),
                             (1, '3ebdc0069497', 'ur10e-pick@r1', 'registered', ['config','weights'])]
```

`released: 0` po zasiewie jest zamierzone. Zasiew wgrywa wagi; wypuszczenie
ich na flotę jest osobną decyzją pod osobnym uprawnieniem i nie dzieje się
przy imporcie.

---

**Faza 2 - moduł `deployment`** (w `mercato/modules/deployment`): kanał stanu
pożądanego. Trzy tabele, cztery komendy, endpoint panelu, dwa endpointy agenta,
strona backendu, trzy komendy CLI, 37 testów jednostkowych.

Teza modułu mieści się w jednym zdaniu: **dzierżawa jest odwrotnością
heartbeatu**. Heartbeat mówi centrali, że robot żyje; dzierżawa mówi robotowi,
jak długo wolno mu pracować bez potwierdzenia z centrali. Konsekwencja jest
twarda: decyzja o zatrzymaniu zapada lokalnie, z zegara i z jednej liczby -
nie wymaga połączenia, zapisu w bazie ani niczyjej zgody.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Osobny endpoint dzierżawy | stan pożądany doklejony do odpowiedzi heartbeatu | agent, który przestałby bić serce, traciłby mandat natychmiast niezależnie od klasy celi - czyli dokładnie to, czemu dzierżawa w celi ogrodzonej ma zapobiegać |
| `fenced` 7 dni, `shared` 8 h, `public` 120 s | jedna długość konfigurowalna globalnie | każda pojedyncza wartość jest albo za krótka dla celi ogrodzonej, albo za długa dla publicznej; administrator ustawia ją pod ten przypadek, który akurat boli |
| Nieznana klasa ryzyka → **najkrótsza** dzierżawa | najdłuższa albo błąd | literówka w konfiguracji celi ma powodować nadmiarowe zatrzymania, a nie ciche przedłużenie pracy w przestrzeni, o której nic nie wiemy |
| Przypisanie i dzierżawa jako dwie tabele | jedno `expires_at` na przypisaniu | zlanie robi z każdej zmiany stanu pożądanego zdarzenie o długości zależnej od jakości łącza |
| Klasa ryzyka kopiowana do przypisania | odczyt z celi przy każdej dzierżawie | przestawienie celi z `public` na `fenced` przedłużyłoby z mocą wsteczną mandat, który już działa w hali |
| Odnowienie po 1/3 okresu | po połowie albo tuż przed | agent musi zdążyć ponowić dwa razy; przy 120 s daje to pierwszą próbę po 40 s i dwie szanse zapasowe |
| Odwołanie dzierżawy jako uzupełnienie | odwołanie jako mechanizm zatrzymania | robot bez łącza i tak się nie dowie; natychmiastowe zatrzymanie należy do deterministycznej warstwy bezpieczeństwa, która nie przechodzi przez tę platformę |
| Brak przypisania → 200 i „stój" | 404 | robot bez przypisania to normalny stan świeżo uruchomionej maszyny; 404 wepchnąłby agenta w pętlę ponawiania jak przy awarii |
| Własny przedrostek podpisu `deployment.lease:` | ten sam podpis, co przy heartbeacie | bez wiązania kontekstu przechwycony heartbeat daje przedłużenie mandatu do pracy |
| `unknown` jako trzeci stan uzgodnienia | milczący robot liczony jako zgodny | to ten sam błąd, co kolumna `online` gaszona zadaniem cyklicznym - pulpit kłamie najgłośniej wtedy, kiedy najbardziej trzeba mu wierzyć |
| Ponowna kontrola rewizji embodimentu przy przypisaniu | zaufanie kontroli z fazy 1 | tam pytaniem było „czy te wagi pasują do tej rewizji", tu „czy ten robot jest tej rewizji" - wymiana chwytaka podnosi rewizję i wczorajsza zgodność dziś nie obowiązuje |
| `employee`: podgląd + odwołanie, bez przypisania | jedno uprawnienie na moduł | ta sama asymetria, co w cyklu życia robota: zatrzymać wolno szeroko, dopuścić - wąsko |

Uruchomienie:

```bash
./mercato/install.sh deployment
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato deployment leases            # ściąga: klasa ryzyka → długość dzierżawy
yarn mercato deployment prove --wait 125  # dowód fazy (trwa ponad dwie minuty)
yarn mercato deployment status
```

Ekran: `/backend/deployment`, uprawnienie `deployment.view`.

### Dowód fazy 2

Warunek zaliczenia brzmiał: *po wygaśnięciu dzierżawy robot w celi `public`
przechodzi do stanu niepracującego bez udziału centrali; ten sam robot w celi
`fenced` pracuje dalej.* „Ten sam robot" wzięte dosłownie - jedna maszyna
dostaje dwie dzierżawy w odstępie sekundy, więc po tej samej ciszy porównujemy
wyłącznie klasę ryzyka:

```
DOWÓD FAZY 2 - dzierżawa jako odwrotność heartbeatu

Długość dzierżawy per klasa ryzyka (z lib/lease.ts):
  fenced    604800 s
  shared     28800 s
  public       120 s

1) UR10E-0001 stoi w celi ogrodzonej
   klasa ryzyka fenced, dzierżawa 604800 s
   mandat do 2026-09-26T05:31:07.070Z (odnowienie po 201600 s)

2) ten sam robot przestawiony do celi publicznej (Cela P)
   klasa ryzyka public, dzierżawa 120 s
   mandat do 2026-09-19T05:33:07.124Z

3) cisza przez 125 s - centrala nie zapisuje niczego
   wierszy przed ciszą 5, po ciszy 5

4) ten sam robot, ta sama cisza, dwie klasy celi:
   cela fenced  (dzierżawa 604800 s): PRACUJE - dzierżawa ważna jeszcze 604674 s
   cela public  (dzierżawa    120 s): NIE PRACUJE - dzierżawa wygasła 6 s temu -
                                       robot zatrzymuje się sam, bez udziału centrali
```

Punkt trzeci jest tym, który cokolwiek dowodzi: liczba wierszy przed ciszą
i po niej jest ta sama. Nic nie zostało zapisane, nikt nie wysłał polecenia
zatrzymania - upłynął czas. Agent w dowodzie nie jest atrapą: generuje
prawdziwą parę Ed25519 i podpisuje prawdziwe żądanie dzierżawy własnym
przedrostkiem, a podpis zebrany w kontekście uderzenia serca jest odrzucany
(test `odrzuca podpis zebrany w kontekście uderzenia serca`).

Ścieżka sieciowa, konto `employee` (`deployment.view`, bez `deployment.assign`):

```
GET /api/deployment/assignments  →  200
totals: {"assignments": 1, "working": 0, "haltedByLease": 1, "drift": 0, "unknown": 1}
byRiskClass: {"public": 1}
UR10E-0001 pick-bin-ur10e v1 public leaseSeconds=120 working=False
  | dzierżawa wygasła 75 s temu - robot zatrzymuje się sam, bez udziału centrali | unknown
```

`unknown` w kolumnie uzgodnienia jest poprawną odpowiedzią, a nie brakiem
danych do ukrycia: agent w dowodzie nigdy nie zgłosił stanu faktycznego,
więc platforma nie twierdzi, że go zna.

#### Błąd znaleziony przy odtwarzaniu dowodu

Pierwsze przejście wywróciło się na `deployment_assignments_active_unique`.
Nadpisanie poprzedniego przypisania i wstawienie nowego szły jednym zrzutem,
a MikroORM wykonał INSERT przed UPDATE-em - przez moment istniały dwa czynne
przypisania tego samego ramienia i baza słusznie odmówiła. Naprawione osobnym
zrzutem przed wstawieniem. To ta sama klasa pułapki, co czytanie `id` przed
`flush()`: kod wygląda poprawnie i wywala się dopiero na bazie. Testy
jednostkowe tego nie złapały i złapać nie mogły - atrapa `EntityManager`
nie ma indeksów.

---

**Faza 3 - moduł `episodes`** (w `mercato/modules/episodes`): księga epizodów
i interwencji. Dwie tabele, trzy komendy, endpoint panelu, strona backendu,
cztery komendy CLI, 35 testów jednostkowych.

Epizod jest atomem pracy manipulatora stacjonarnego. **Interwencja człowieka
jest osobnym obiektem pierwszorzędnym**, a nie polem `aborted_by` na epizodzie,
i to jest całe rozstrzygnięcie tej fazy. Liczbę epizodów między interwencjami
da się policzyć i z pola, i z tabeli - ale pytanie „na którym etapie ludzie
przerywają najczęściej", od którego zaczyna się następny trening, daje się
zadać wyłącznie tabeli.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Interwencja jako własna tabela | pole `aborted_by` na epizodzie | interwencja ma własny czas, etap, sprawcę i przyczynę; wtłoczona w kolumnę gubi wszystkie cztery i zostaje tylko „była" |
| Interwencja **nie** zmienia wyniku epizodu | automatyczne `outcome = aborted` | skasowałoby różnicę między „człowiek poprawił coś w locie, zadanie się udało" a „człowiek przerwał, zadanie przepadło" |
| Epizod bez `policy_version_id` jest dopuszczalny | wymóg przypisania | praca teleoperacyjna też jest epizodem; wykluczenie jej zawyżałoby autonomię dokładnie o te przypadki, w których jej nie było |
| `episode_id` na interwencji nullowalne | `not null` | człowiek, który zatrzymał stanowisko między epizodami, też interweniował |
| Brak interwencji → `meanEpisodesBetweenInterventions = null` | nieskończoność albo bardzo duża liczba | zero interwencji na trzech epizodach nie jest dowodem autonomii, tylko brakiem danych, i raport ma to mówić wprost |
| Epizod z interwencją nie należy do serii, którą kończy | zaliczanie go do serii | zawyżałoby wynik o jeden przy każdym przerwaniu, czyli najbardziej tam, gdzie wdrożenie idzie źle |
| Rodzaje interwencji uporządkowane po ciężarze | jeden licznik „przerwań" | wdrożenie z samymi poprawkami otoczenia i wdrożenie z samymi zatrzymaniami awaryjnymi mają identyczny licznik i nie są tym samym wdrożeniem |
| Raport liczony czystą funkcją na wczytanej księdze | agregat w SQL-u raportu | reguła w SQL-u jest nieweryfikowalna inaczej niż drugim SQL-em; ta ma test jednostkowy na każdy wariant serii |
| Licznik interwencji zdenormalizowany **plus** komenda przeliczająca | sama denormalizacja albo samo złączenie | denormalizacja bez drogi powrotnej to dług spłacany ręcznym UPDATE-em o drugiej w nocy |
| `verifyAgainstLedger` w odpowiedzi endpointu | kontrola tylko w teście | rozjazd raportu z księgą ma być widoczny na ekranie, a nie zauważony po kwartale |
| Numer kolejny epizodu nadaje centrala | numer od agenta | agent po restarcie zaczyna od nowa, a kadencja liczona jest po całym życiu maszyny |
| `employee` może zgłaszać interwencje | uprawnienie dla przełożonego | uprawnienie, o które trzeba prosić, kończy się niezgłaszanymi interwencjami - a to psuje jedyną liczbę, która mówi, czy wdrożenie idzie do przodu |

Uruchomienie:

```bash
./mercato/install.sh episodes
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato deployment assign --robot FR3-0001 --policy insert-peg-fr3 --release
yarn mercato episodes simulate --count 120 --seed 77001
yarn mercato episodes cadence
yarn mercato episodes prove        # dowód fazy
yarn mercato episodes reconcile    # przeliczenie liczników z tabeli interwencji
```

Ekran: `/backend/episodes`, uprawnienie `episodes.view`.

### Dowód fazy 3

Warunek zaliczenia brzmiał: *raport „epizody między interwencjami" liczony per
polityka i per cela, zgodny co do sztuki z księgą epizodów.* „Co do sztuki"
sprawdzamy krzyżowo - raport liczy czysta funkcja przechodząca po wczytanej
księdze, a kontrolę liczy **baza** osobnym zapytaniem, które nie dotyka
licznika zdenormalizowanego:

```
DOWÓD FAZY 3 - kadencja autonomii zgodna z księgą

1) raport kontra księga
   raport: 200 epizodów, 27 interwencji
   księga: 200 epizodów, 27 interwencji
   spójne: true

2) epizody między interwencjami per polityka (raport ↔ niezależne zapytanie)
   insert-peg-fr3 v1    raport ep   60 int   6  │  SQL ep   60 int   6  │  zgodne  │  ep/int 10.00
   pick-bin-ur10e v1    raport ep   50 int   6  │  SQL ep   50 int   6  │  zgodne  │  ep/int  8.33
   pick-bin-ur10e v2    raport ep   30 int   4  │  SQL ep   30 int   4  │  zgodne  │  ep/int  7.50
   (bez polityki)        ep 60  int 11  - poza raportem per polityka, celowo

3) epizody między interwencjami per cela (raport ↔ niezależne zapytanie)
   Cela A - gniazdo odkładcze      raport ep  200 int  27  │  SQL ep  200 int  27  │  zgodne

4) niezmiennik serii
   suma długości serii 173 = epizody bez interwencji 173: true
   z interwencją 27 + bez 173 = 200: true

   Rozjazdów: 0. Raport zgadza się z księgą co do sztuki.
```

Zgodność sama w sobie nic nie dowodzi, jeśli kontrola nie potrafi zawieść.
Dlatego drugą połową dowodu jest celowe zepsucie licznika jednym UPDATE-em
i sprawdzenie, że raport to zauważa:

```
$ psql -c "update episodes_episodes set intervention_count = intervention_count + 1
           where id = (select id from episodes_episodes order by sequence limit 1)"

$ yarn mercato episodes prove
   raport: 200 epizodów, 28 interwencji
   księga: 200 epizodów, 27 interwencji
   spójne: false
   ROZJAZD: liczba interwencji: raport 28, księga 27
   Cela A - gniazdo odkładcze      raport ep  200 int  28  │  SQL ep  200 int  27  │  ROZJAZD
   Rozjazdów: 1. RAPORT NIE ZGADZA SIĘ Z KSIĘGĄ.

$ yarn mercato episodes reconcile
Sprawdzono epizodów: 200, poprawiono: 1
  beeb37b3-0393-4665-afc3-5db2bf94c965: licznik 2 → 1

$ yarn mercato episodes prove
   spójne: true
   Rozjazdów: 0. Raport zgadza się z księgą co do sztuki.
```

Ścieżka sieciowa, konto `employee`:

```
GET /api/episodes/cadence  →  200
ledger: {'episodes': 200, 'interventions': 27} consistency: {'consistent': True, 'problems': []}
overall: ep=200 int=27 ep/int=7.41 seria=7 najdl=15 autonomia=86.5%
  polityka insert-peg-fr3 v1 ep=60 int=6 ep/int=10.00
  polityka pick-bin-ur10e v1 ep=50 int=6 ep/int=8.33
  polityka pick-bin-ur10e v2 ep=30 int=4 ep/int=7.50
po etapie:    {"przeniesienie": 10, "podejście": 7, "odłożenie": 5, "wycofanie": 5}
po ciężarze:  {"abort": 5, "adjust": 9, "estop": 7, "manual_reset": 2, "teleop_takeover": 4}
```

Dwie ostatnie linie są tym, po co ta faza powstała. „Przeniesienie" jako
najczęstszy etap przerwania to konkretna lista epizodów do zebrania w zbiór
fazy 6; siedem zatrzymań awaryjnych przy dziewięciu poprawkach otoczenia to
zupełnie inne wdrożenie niż dziewięć poprawek i zero `estop`, mimo że łączny
licznik przerwań byłby identyczny.

#### Błędy znalezione przez `tsc --noEmit` po zielonej suicie

Dwa, oba niewidoczne w 35 testach:

- `as never` przy `em.findOne` zawęziło typ zmiennej do `never`, przez co
  **każdy** odczyt pola z epizodu był błędem typu. Testy tego nie widzą, bo
  atrapa `EntityManager` jest typowana luźno. Naprawione nazwanym aliasem
  `EpisodeRef` i rzutowaniem przez `unknown`.
- `KpiCard` przyjmuje `value: number | null`, a komponent podawał sformatowany
  łańcuch. Naprawione przez `formatValue`.

To jest dokładnie ten krok, o którym mowa w regule projektu: zielona suita nie
jest warunkiem zaliczenia.

---

**Faza 4 - moduł `rollout`** (w `mercato/modules/rollout`): wdrożenia etapowe
z bramą. Cztery tabele, trzy komendy, endpoint panelu, strona backendu, dwie
komendy CLI, 34 testy jednostkowe.

Brama odwołuje się do liczb z księgi epizodów, nie do opinii. **Nie ma
uprawnienia „pomiń bramę" i nie będzie** - człowiek może zatrzymać wdrożenie
w każdej chwili, ale nie może go przepchnąć obok liczb. To jedyne, co odróżnia
wdrożenie etapowe od wdrożenia na raz z dodatkowym spotkaniem.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Wycofanie jest domyślną reakcją na przekroczenie progu | wstrzymanie do wyjaśnienia | wycofanie jest tańsze niż diagnoza; odwrotna kolejność zostawia maszyny na podejrzanej polityce na czas dochodzenia |
| Za mało danych → `hold`, nie `advance` | traktowanie braku interwencji jako sukcesu | zero interwencji na trzech epizodach nie jest lepszym wynikiem niż dwie na dwustu |
| Jedna interwencja ciężka wycofuje przed kompletem danych | czekanie na próg liczebności | `estop` nie jest wskaźnikiem jakości, tylko zdarzeniem; czekanie na pięćdziesiąty epizod po pierwszym zatrzymaniu awaryjnym to statystyka zamiast decyzji |
| Osobny próg na interwencje ciężkie | jeden próg na wszystkie przerwania | wdrożenie z samymi poprawkami otoczenia i wdrożenie z samymi `estop` mają identyczny udział interwencji i nie są tym samym wdrożeniem |
| Osobny próg skuteczności | sam próg interwencji | polityka, która nie robi nic złego i nic dobrego, też ma zostać wycofana |
| Progi na **etapie**, nie na wdrożeniu | jeden próg dla całości | zmuszałby do ustawienia go pod etap ostatni, czyli do przepuszczenia wszystkiego wcześniej |
| Poprzednia wersja zapisywana przy **planowaniu** | odtwarzanie jej przy wycofaniu | wycofanie dzieje się, gdy coś się pali, i nie może zależeć od zapytania, które akurat wtedy zwróci co innego |
| Robot bez wcześniejszej polityki wraca do „bez polityki" | podstawienie dowolnej innej wersji | wdrożenie wykonane w panice jest dokładnie tym, czemu wycofanie ma zapobiegać |
| Wycofanie idzie komendą `deployment.assignments.assign` | zapis do tabeli wdrożeń | inaczej stan pożądany w hali rozjeżdża się ze stanem wdrożenia w panelu |
| Zatrzymywane są **wszystkie** etapy następne | tylko kolejny | wdrożenie pięcioetapowe, w którym po wycofaniu etapu 1 rusza etap 3, jest wdrożeniem jednoetapowym z opóźnieniem |
| Robot, którego nie da się objąć etapem, jest pomijany | przerwanie startu etapu | maszyna w serwisie to normalny stan floty; wdrożenie wywracające się na pierwszym takim robocie nie ruszy nigdy - pominięcia lądują w wyniku komendy |
| Ten sam robot nie może być w dwóch etapach | brak kontroli | wycofanie etapu 1 zdjęłoby politykę maszynie zbierającej dane dla etapu 3, a brama etapu 3 orzekałaby o populacji, której nie ma |
| Ograniczenie trybu cieniowego zapisane jako funkcja `shadowProves` | akapit w dokumentacji | cień nie dowodzi bezpieczeństwa polityki zmieniającej stan świata; kto chce pominąć etap czynny, ma to jawnie obejść i zostawić ślad |
| Dziennik bramy dopisywany, ze zmierzonymi wartościami | jedno pole „ostatni werdykt" | nadpisywanie kasuje odpowiedź na pytanie, ile razy wdrożenie ocierało się o próg, zanim go przekroczyło - a to jedyna rzecz, którą widać zawczasu |

Uruchomienie:

```bash
./mercato/install.sh rollout
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato rollout prove     # dowód fazy
yarn mercato rollout status
```

Ekran: `/backend/rollout`, uprawnienie `rollout.view`.

### Dowód fazy 4

Warunek zaliczenia brzmiał: *przekroczenie progu interwencji na etapie 1
zatrzymuje etap 2 i wycofuje etap 1 bez udziału człowieka.* Dowód ma dwie
części, bo jedna nie wystarcza: sam przypadek negatywny dowodziłby tylko tego,
że da się napisać funkcję zawsze zwracającą „wycofaj".

```
DOWÓD FAZY 4 - brama etapowa odwołuje się do liczb, nie do opinii

   przed wdrożeniem: UR10E-0001 → pick-bin-ur10e v1
   progi etapu: ep ≥ 20, interwencje ≤ 10%, ciężkie ≤ 2%, skuteczność ≥ 80%

A) wdrożenie, które przekracza próg interwencji
   etap 1 uruchomiony; UR10E-0001 → pick-bin-ur10e v2
   etap 1: 24 epizodów, 6 interwencji
   brama etapu 1: rollback - próg przekroczony - interwencje 25.0% > 10.0%; skuteczność 75.0% < 80.0%
   zatrzymanych etapów następnych: 1; wycofanych robotów: 1
   po wycofaniu: UR10E-0001 → pick-bin-ur10e v1 (przed wdrożeniem miał pick-bin-ur10e v1)
   etap 2 odrzucony: Etap jest w stanie halted, a nie oczekującym.

B) wdrożenie, które przechodzi bramę
   etap 1: 25 epizodów, 0 interwencji
   brama etapu 1: advance - 25 epizodów, interwencje 0.0%, skuteczność 100.0% - w granicach
   etap 2 uruchomiony

C) dziennik bramy - kto zdecydował
   rollback  automat
   advance   automat
```

Punkt C jest tym, który odpowiada na „bez udziału człowieka": kolumna sprawcy
w dzienniku bramy jest pusta przy obu wpisach. Podpis człowieka w tej kolumnie
znaczyłby, że automat nie zdążył - i to też jest informacja, dlatego kolumna
istnieje.

Epizody w dowodzie idą **komendą księgi**, a nie INSERT-em: brama ma czytać
dokładnie to, co czyta raport kadencji z fazy 3. Gdyby dowód wpisywał wiersze
z pominięciem komendy, dowodziłby zgodności bramy z tym INSERT-em.

Ścieżka sieciowa, konto `employee` (`rollout.view`, bez `rollout.plan`):

```
GET /api/rollout/rollouts  →  200
totals: {"rollouts": 6, "running": 3, "rolledBack": 3, "completed": 0}
Dowód 4B - czyste liczby | pick-bin-ur10e v2 | running
   1. Etap 1 - jeden robot  status=passed  roboty=1 (wycofanych 0)
      brama: advance  ep=25 int=0.0% skut=100.0%  automat=True
   2. Etap 2 - reszta celi  status=running  roboty=1 (wycofanych 0)
Dowód 4A - próg przekroczony | pick-bin-ur10e v2 | rolled_back
      | próg przekroczony - interwencje 25.0% > 10.0%; skuteczność 75.0% < 80.0%
   1. Etap 1 - jeden robot  status=rolled_back  roboty=1 (wycofanych 1)
      brama: rollback  ep=24 int=25.0% skut=75.0%  automat=True
   2. Etap 2 - reszta celi  status=halted  roboty=1 (wycofanych 0)
```

#### Dwa błędy znalezione przy odtwarzaniu dowodu

- **We własnym generatorze danych, nie w bramie.** Pierwsze przejście pokazało
  12,5% interwencji zamiast 25%. Epizody były rozstawione co sekundę, więc
  epizody wcześniejszego etapu wpadały w okno czasowe etapu następnego
  i rozcieńczały dokładnie ten sygnał, który brama ma wyłapać. Gdyby zostało,
  dowód mówiłby co innego, niż twierdzi.
- **W kolejności samego dowodu.** Przy wariancie udanym przed nieudanym robot
  miał już wersję docelową i wycofanie sprowadzało się do przypisania mu tego,
  co i tak ma - widać było werdykt, a nie skutek. Wariant nieudany idzie teraz
  pierwszy, a dowód jawnie ustawia punkt wyjścia.
- **W atrapie testu, nie w kodzie.** Zapytanie bramy zawiera
  `rollout_stage_members` w podzapytaniu populacji i było łapane przez
  wcześniejszą gałąź atrapy, przez co brama dostawała listę składu etapu
  zamiast statystyk i każdy werdykt wychodził `hold`. Cztery testy były
  czerwone z powodu atrapy, nie implementacji - i naprawa poszła w atrapę,
  bez rozluźniania asercji.

---

**Faza 5 - moduł `safety`** (w `mercato/modules/safety`): uzasadnienie
bezpieczeństwa, ewaluacja i incydenty. Cztery tabele, siedem komend, endpoint
panelu, strona backendu, trzy komendy CLI, 43 testy jednostkowe.

To jest warstwa, która odpowiada regulatorowi: rozporządzenie (UE) 2023/1230
(stosowane od 20 stycznia 2027), AI Act art. 6 ust. 1, ISO 10218-1/-2:2025,
ISO/TS 15066:2016.

**Kierunek zależności został tu odwrócony względem intuicji.** `deployment`
zyskał zależność od `safety`, a nie odwrotnie: dopuszczenie jest warunkiem
wstępnym przypisania stanu pożądanego, a nie jego skutkiem ubocznym.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| `deployment` woła `safety.clearance.check` przed zapisem | subskrybent zdarzeń odwołujący przypisanie po fakcie | wariant zdarzeniowy wygląda czyściej i zostawia okno, w którym robot pracuje niedopuszczoną polityką - długość okna zależy od opóźnienia kolejki |
| `cell_class` jako tekst | klucz obcy do `fleet_cells` | dopuszczenie dotyczy **klasy** celi; klucz obcy kazałby pisać osobne uzasadnienie dla każdej nowej celi o niezmienionej konfiguracji, a taki koszt kończy się dopuszczeniami hurtem bez czytania |
| Kolumna `declared_as_safety_function` istnieje po to, żeby była fałszem | brak kolumny i milczące założenie | założenie nie zostawia śladu; kolumna zmusza do jawnej decyzji, a zatwierdzenie jej odmawia z przywołaniem Annex I części A |
| Odmowa na poziomie **zatwierdzenia**, nie dopiero dopuszczenia | odmowa tylko przy wdrożeniu | zatwierdzony dokument z taką deklaracją szkodzi bardziej niż jego brak: jest dowodem, że wiedziano i mimo to zatwierdzono |
| Deklaracja **wycofana** przestaje blokować | blokada trwała | reguła bez legalnej drogi odwrotu uczy obchodzenia systemu i przestaje chronić cokolwiek; ślad po wycofaniu zostaje w tabeli z powodem |
| `safety_layer` obowiązkowy przy zatwierdzeniu | pole opcjonalne | uzasadnienie, które nie mówi, **co** zatrzyma maszynę, gdy polityka zawiedzie, jest opisem nadziei |
| `valid_until` obowiązkowy przy zatwierdzeniu | dopuszczenie bezterminowe | ta sama zasada, co przy dacie ważności kalibracji: dopuszczenie bez terminu to dopuszczenie, o którym nikt nigdy nie przypomni |
| Dopuszczenie bierze **najnowszy** przebieg zestawu | „czy kiedykolwiek przeszedł" | zestaw powtórzony po zmianie w celi i niezaliczony unieważnia poprzedni sukces; szukanie historycznego zaliczenia dawałoby zgody na podstawie wyniku sprzed roku |
| Przebieg na innym odcisku kontraktu embodimentu nie liczy się | porównanie tylko po wersji polityki | najczęstsza droga do dopuszczenia „na podstawie testów", których nikt nie powtórzył po wymianie chwytaka |
| `required_for` to lista klas ryzyka | jedna klasa per zestaw | limity siły z ISO/TS 15066 mają sens tam, gdzie kontakt jest możliwy; wymaganie ich za płotem byłoby rytuałem, a rytuały uczą omijania wymagań |
| Klasyfikacja incydentu dwuwymiarowa | jedna skala ciężkości | skala skleiłaby „czy ktoś ucierpiał" z „czy zawiodła warstwa bezpieczeństwa" i zgubiła najważniejszy przypadek: zdarzenie bez skutków, w którym ostatnia linia zadziałała |
| Incydent wstrzymujący wycofuje uzasadnienie dla klasy celi | zatrzymanie pojedynczego wdrożenia | skoro dopuszczenie dotyczy klasy, to zdarzenie podważające je podważa je dla wszystkich cel tej klasy - i każde kolejne przypisanie odbija się samo |
| `safety.clearance.check` jako komenda odczytu | zwykłe zapytanie | pytanie „czy wolno wdrożyć tę wersję w tej klasie celi" trzeba umieć odtworzyć po trzech latach razem z datą i aktorem |
| Uzasadnienie wycofane wraca do `draft` przy ponownym redagowaniu | drugi wiersz dla tej samej pary | dwa uzasadnienia dla tej samej pary to dwa dokumenty, z których jeden jest nieaktualny, a przy odczycie nie wiadomo który |
| `employee` bez `safety.approve` | jedno uprawnienie | zatwierdzenie jest podpisem pod dokumentem regulacyjnym, nie czynnością operacyjną; zgłaszanie incydentów odwrotnie - nadane szeroko, bo incydent wymagający proszenia o dostęp bywa niezgłaszany |

Uruchomienie:

```bash
./mercato/install.sh safety && ./mercato/install.sh deployment
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato safety seed     # katalog zestawów ewaluacyjnych
yarn mercato safety prove    # dowód fazy
yarn mercato safety status
```

Ekran: `/backend/safety`, uprawnienie `safety.view`.

#### Koszt kolejności faz

Faza 5 unieważniła dowód fazy 4. Brama bezpieczeństwa stanęła przed każdym
przypisaniem, a dowód fazy 4 opiera się na wdrażaniu i wycofywaniu wersji -
odbijał się więc na pierwszym kroku i kończył błędem, zamiast pokazywać
zachowanie, o którym mówi.

Naprawa poszła w **dowód**, nie w bramę: `rollout prove` sam ustanawia teraz
uzasadnienie i przebiegi ewaluacyjne dla obu wersji, idempotentnie. Brama
blokowała poprawnie i nie było powodu jej ruszać.

To jest realna cena układania warstwy bezpieczeństwa po warstwie wdrożeń,
i warto ją zapisać: każda faza dokładająca warunek wstępny unieważnia dowody
faz wcześniejszych, które tego warunku nie znały. Przy większej liczbie faz
przestaje to być pojedynczą poprawką, a staje się kosztem stałym.

### Dowód fazy 5

Warunek zaliczenia brzmiał: *wersja polityki bez kompletu przejść
ewaluacyjnych nie daje się wdrożyć w celi klasy, dla której uzasadnienie nie
zostało zatwierdzone.* Kluczowe jest, **skąd** przychodzi odmowa - z komendy
przypisania stanu pożądanego, a nie z osobnego raportu:

```
DOWÓD FAZY 5 - dopuszczenie dotyczy klasy celi, nie celi

   robot FR3-0001, klasa celi fenced-pick-place, ryzyko fenced
   wersja insert-peg-fr3 v1
   zestawy wymagane dla ryzyka fenced: grasp-release-integrity, reach-envelope

1) brak uzasadnienia i brak przebiegów ewaluacyjnych
   dopuszczenie: false; powody: brak zatwierdzonego uzasadnienia bezpieczeństwa
     dla klasy celi fenced-pick-place | brak przebiegu zestawów wymaganych dla
     klasy ryzyka fenced: reach-envelope, grasp-release-integrity
   odbite: Wersja insert-peg-fr3 v1 nie jest dopuszczona do klasy celi fenced-pick-place: …

2) komplet zaliczonych zestawów, uzasadnienie tylko w wersji roboczej
   dopuszczenie: false; powody: uzasadnienie bezpieczeństwa dla klasy celi
     fenced-pick-place jest w wersji roboczej i nie zostało zatwierdzone
   odbite: Wersja insert-peg-fr3 v1 nie jest dopuszczona do klasy celi fenced-pick-place: …

3) uzasadnienie zatwierdzone dla KLASY celi
   dopuszczenie: true
   WDROŻONE

4) jeden zestaw przebiegł ponownie i nie przeszedł
   dopuszczenie: false; powody: zestawy zakończone niepowodzeniem: grasp-release-integrity
   (dopuszczenie bierze NAJNOWSZY przebieg, nie jakikolwiek zaliczony)
   odbite: Wersja insert-peg-fr3 v1 nie jest dopuszczona do klasy celi fenced-pick-place: …

5) próba zatwierdzenia uzasadnienia deklarującego politykę jako funkcję bezpieczeństwa
   odbite: Uzasadnienie deklaruje uczoną politykę jako funkcję bezpieczeństwa.
     Nie da się tego zatwierdzić: wpycha maszynę w Annex I część A rozporządzenia
     2023/1230, czyli w ocenę przez jednostkę notyfikowaną, dla której nie istnieje
     ustalona metoda wykazania zgodności. Bezpieczeństwo egzekwuje osobna warstwa
     deterministyczna.
   po wycofaniu sondy dopuszczenie dla fenced-pick-place: false
     (powody: zestawy zakończone niepowodzeniem: grasp-release-integrity)
```

Punkt 2 jest najważniejszy, bo jest najgroźniejszy: komplet zaliczonych
zestawów sprawia wrażenie, że wszystko jest gotowe. Punkt 4 pokazuje, że
zaliczenie nie jest wieczne. Punkt 5 jest jedynym w całym projekcie
miejscem, w którym platforma odmawia czegoś **bezwarunkowo**, niezależnie od
kompletu testów.

Ścieżka sieciowa, konto `employee` (`safety.view`, bez `safety.approve`):

```
GET /api/safety/clearance  →  200
totals: {"versions": 3, "cellClasses": 2, "cleared": 0, "blocked": 6,
         "declaredAsSafetyFunction": 0, "openIncidents": 0}
  insert-peg-fr3 v1  fenced-pick-place  fenced  ZABLOKOWANA  zestawy zakończone
                                                  niepowodzeniem: grasp-release-integrity
  insert-peg-fr3 v1  public-handover    public  ZABLOKOWANA  brak zatwierdzonego uzasadnienia …
  pick-bin-ur10e v1  fenced-pick-place  fenced  ZABLOKOWANA  brak zatwierdzonego uzasadnienia …
  pick-bin-ur10e v1  public-handover    public  ZABLOKOWANA  brak zatwierdzonego uzasadnienia …
  pick-bin-ur10e v2  fenced-pick-place  fenced  ZABLOKOWANA  brak zatwierdzonego uzasadnienia …
  pick-bin-ur10e v2  public-handover    public  ZABLOKOWANA  brak zatwierdzonego uzasadnienia …
```

Macierz jest w całości czerwona i to jest poprawny obraz stanu instancji:
wersje wdrożone w fazach 2-4 powstały, **zanim** brama bezpieczeństwa
istniała. Faza 5 ich nie zdejmuje - przypisania już istniejące zostają -
ale żadne nowe przypisanie tych wersji nie przejdzie. Zamiatanie tego przez
wsteczne dopuszczanie byłoby dokładnie tym, czemu ta warstwa ma zapobiegać.

#### Dwa błędy znalezione przy odtwarzaniu dowodu

- **Trwała blokada po wycofanej deklaracji.** Reguła sprawdzała
  `declaredAsSafetyFunction` bez patrzenia na status uzasadnienia, więc raz
  postawiona deklaracja blokowała wersję **na zawsze i we wszystkich klasach
  celi**, bez legalnej drogi wyjścia poza ręcznym DELETE w bazie. Naprawione:
  liczą się wyłącznie uzasadnienia nie wycofane. Reguła bez drogi odwrotu uczy
  obchodzenia systemu i przestaje chronić cokolwiek.
- **Sonda dowodu zostawiała trwały stan.** Krok 5 zakładał uzasadnienie
  z deklaracją i go nie sprzątał, przez co drugie uruchomienie dowodu
  wywracało się na własnych śmieciach. Dowód wycofuje teraz sondę na koniec
  (wycofanie, nie DELETE - ślad po próbie zostaje).

---

**Faza 6 - moduł `datasets`** (w `mercato/modules/datasets`): zbiory danych
i pochodzenie. Cztery tabele, cztery komendy, endpoint panelu, strona
backendu, dwie komendy CLI, 41 testów jednostkowych.

Moduł ma uczynić prawdziwym jedno zdanie: **dla dowolnej wersji polityki da
się wskazać zbiór, a dla zbioru - listę epizodów źródłowych, i odwrotnie.**
Bez tego regres jakości po treningu jest nie do zdiagnozowania: polityka v7
zachowuje się gorzej od v6 i zostają dwie hipotezy - zmiana w danych albo
zmiana w treningu - których nie da się rozdzielić.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Epizod z interwencją to `correction`, **nawet przy sukcesie** | rola z samego wyniku epizodu | epizod, w którym człowiek poprawił chwyt, wrzucony do `demo` uczy model, że tak właśnie ma wyglądać poprawny przebieg - to najczęstszy sposób, w jaki zbiór po cichu psuje następną wersję |
| Tożsamością wersji zbioru jest odcisk zawartości | numer nadawany przy każdym budowaniu | przebudowanie z tych samych kryteriów nad niezmienioną księgą ma dać tę samą wersję; inaczej zdanie „polityka v7 uczyła się na zbiorze X w wersji 3" nie ma stabilnego odniesienia |
| Podział na część ewaluacyjną liczony z identyfikatora epizodu | losowanie | losowanie dałoby przy każdym budowaniu inny podział, więc dwa przebiegi z tych samych kryteriów byłyby dwiema wersjami - co unieważnia deduplikację po odcisku |
| Część ewaluacyjna wydzielana **przed** przypisaniem roli treningowej | najpierw rola, potem podział | epizod odłożony na ewaluację nie może być jednocześnie demonstracją treningową; inaczej wynik na części wydzielonej przestaje cokolwiek mówić |
| Wersja budowana **z księgi** po kryteriach | z listy epizodów podanej przez wołającego | lista jest zapisem tego, co ktoś twierdzi, że wziął; budowanie z kryteriów czyni skład funkcją księgi i pozwala go odtworzyć |
| Filtr rodziny embodimentu po stronie serwera | filtr w kryteriach wołającego | to nie jest preferencja, tylko warunek sensowności: dane z jednego sprzętu nie są danymi dla innego |
| Przebieg treningowy jako osobna tabela | pole `dataset_version_id` na wersji polityki | z jednego zbioru wychodzi kilka polityk (ziarna, hiperparametry), a jedna polityka bywa dostrajana kolejno na dwóch zbiorach; pole nie uniesie żadnego z tych przypadków |
| Wiązanie powstaje przy **domknięciu** przebiegu | przy jego rejestracji | przy rejestracji polityki jeszcze nie ma; wiązanie zapisywane po stronie rejestru polityk wymagałoby, żeby rejestr wiedział o zbiorach |
| Przebieg udany **musi** wskazać wersję polityki | pole opcjonalne | to jest dziura w pętli: zbiór byłby źródłem czegoś, czego nie da się wskazać |
| Przebieg nieudany może zostać zamknięty bez polityki | wymóg polityki zawsze | nieudany trening też jest informacją o zbiorze |
| Skład zbioru to odniesienia do epizodów | kopia danych w tabeli | warunek trzeci raportu: bajty przebiegów nie przechodzą przez MikroORM |
| Ostrzeżenia o składzie zamiast twardej odmowy | odmowa budowania złego zbioru | zbiór czysto korekcyjny bywa dokładnie tym, czego ktoś potrzebuje; odmowa zmuszałaby do obchodzenia systemu, a ostrzeżenie zapisane przy wersji wypływa przy diagnozie |
| `datasets.train` osobno od `datasets.build` | jedno uprawnienie | zbiór zbudowany przypadkiem da się odbudować; wiązanie wpisane przypadkiem kłamie cicho |
| Zbiór bez przebiegu **nie** łamie pętli | liczenie go jako dziury | świeżo zbudowany zbiór jest normalnym stanem; pętla jest zamknięta, gdy każda polityka ma skąd pochodzić i każdy zbiór ma z czego się składać |

Uruchomienie:

```bash
./mercato/install.sh datasets
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato datasets prove    # dowód fazy
yarn mercato datasets status
```

Ekran: `/backend/datasets`, uprawnienie `datasets.view`.

### Dowód fazy 6

Warunek zaliczenia brzmiał: *dla dowolnej wersji polityki da się wskazać
zbiór, a dla zbioru - listę epizodów źródłowych, i odwrotnie.* „I odwrotnie"
jest sprawdzane dosłownie: jedno zapytanie idzie od polityki do epizodów,
drugie od epizodu do polityk, i oba muszą wskazać ten sam zbiór. Sprawdzenie
w jedną stronę przeszłoby również dla modelu, w którym pochodzenie jest
luźnym polem JSON.

```
DOWÓD FAZY 6 - pętla zamknięta w obie strony

1) budowanie wersji zbioru z księgi epizodów
   wersja 1, epizodów 247, odcisk 011d4216c38f, powtórka=false

2) przebudowanie z tych samych kryteriów nad niezmienioną księgą
   zwrócono wersję 1, powtórka=true

3) przebieg treningowy i domknięcie pętli
   próba zamknięcia przebiegu bez wskazania polityki → odbite: Przebieg zakończony
     sukcesem musi wskazać wersję polityki, która z niego powstała.
   przebieg train-mu8034cn zamknięty; powstała polityka pick-bin-ur10e v2

4) od wersji polityki do epizodów źródłowych
   pick-bin-ur10e v2 ← bin-picking-ur10e v1: 247 epizodów (27 korekcyjnych)

5) od pojedynczego epizodu do polityk, które się na nim uczyły
   epizod 00bec9e3… (rola correction) →
     bin-picking-ur10e v1 → pick-bin-ur10e v2
   obie strony wskazują tę samą politykę: true

6) pętla dla całej instancji
   wersje polityki bez wskazanego zbioru: 2 (insert-peg-fr3 v1, pick-bin-ur10e v1)
   wersje zbioru bez epizodów: 0
```

Punkt 2 jest tym, który odróżnia rejestr zbiorów od katalogu plików: licznik
wersji nie drgnął, mimo że komenda wykonała się normalnie. Punkt 6 jest
celowo niepełny i to jest właściwy wynik - `insert-peg-fr3 v1`
i `pick-bin-ur10e v1` zostały wgrane ręcznie w fazie 1, zanim potok treningowy
istniał. Platforma mówi o nich wprost zamiast udawać, że pochodzenie jest znane.

Ścieżka sieciowa, konto `employee` (`datasets.view`, `datasets.build`, bez
`datasets.train`):

```
GET /api/datasets/datasets  →  200
totals: {"datasetVersions": 1, "trainingRuns": 1, "loopClosed": false,
         "policiesWithoutDataset": 2, "datasetsWithoutEpisodes": 0,
         "datasetsWithoutPolicy": 0}
orphanPolicies: ['insert-peg-fr3 v1', 'pick-bin-ur10e v1']
  bin-picking-ur10e v1 ep=247 {"demo": 165, "correction": 27, "failure": 4,
                               "holdout": 51} odcisk=011d4216c38f
     przebieg train-mu8034cn succeeded -> pick-bin-ur10e v2
  odwrotnie: pick-bin-ur10e v2 <- 1 wersji zbioru, 247 epizodow
```

`loopClosed: false` z nazwanymi sierotami jest uczciwszą odpowiedzią niż
zielony wskaźnik: endpoint nie zlicza dwóch różnych dziur razem, bo polityka
bez zbioru i zbiór bez epizodów to dwa różne problemy.

## Stan po fazach 0-6

Osiem modułów, 31 tabel. Łańcuch, który przechodzi
przez wszystkie fazy, wygląda tak:

```
fleet          co istnieje i czy wolno mu pracować
  ↓
edge           kto się odzywa i czym to udowadnia
  ↓
policy_registry  co to za polityka i na czym wolno ją uruchomić
  ↓
safety         czy wolno ją uruchomić w tej KLASIE celi
  ↓
deployment     ten robot ma uruchomić tę wersję, na tak długo
  ↓
episodes       co zrobił i kto przerwał
  ↓
rollout        czy iść dalej, czy wycofać - z liczb, nie z opinii
  ↓
datasets       z czego to się wzięło i co z tego powstanie
```

Kierunek strzałek jest kierunkiem zależności i jest jednostronny w każdym
ogniwie poza jednym: `deployment → safety` został dołożony w fazie 5, bo
dopuszczenie musi być warunkiem wstępnym przypisania, a nie jego skutkiem
ubocznym. Wszystkie pozostałe moduły działają bez tych, które są pod nimi:
rejestr floty bez jednej polityki, rejestr polityk bez jednego wdrożenia,
księga epizodów bez wdrożenia etapowego.

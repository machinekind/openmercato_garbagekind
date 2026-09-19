# Zadania dla zespołu physical

Lista tego, co trzeba **wytrenować** i **udokumentować**, żeby wynik dał się
wpiąć w tę platformę bez przepisywania go po drodze.

Nie jest to lista życzeń. Każda pozycja ma podane, co konkretnie odmówi
działania, gdy jej zabraknie — bo część z nich to **twarde bramki w kodzie**,
które odrzucą wgranie, a nie ostrzegą.

Czytać razem z:
[`EMBODIMENTS.md`](EMBODIMENTS.md) (format opisu sprzętu),
[`ROADMAP.md`](ROADMAP.md) (co która faza dostarcza),
[`EVENTS.md`](EVENTS.md) (co system ogłasza).

---

## Legenda

| Znacznik | Znaczenie |
| --- | --- |
| 🔴 **BRAMKA** | bez tego komenda rzuca wyjątkiem; nic nie wejdzie do systemu |
| 🟡 **OSTRZEŻENIE** | wejdzie, ale z zapisanym brakiem — i wyjdzie przy dopuszczeniu |
| ⚪ **JAKOŚĆ** | nic nie blokuje, ale bez tego dane są słabsze, niż wyglądają |

---

## Blok A — kontrakt sprzętu

Wszystko poniżej dotyczy **rewizji embodimentu**, a nie egzemplarza robota.
Robot jest egzemplarzem; kontraktem jest rewizja. To rozróżnienie jest
w kodzie, nie w dokumentacji: polityka wiąże się z rewizją i da się ją
sprawdzić w chwili wgrania, kiedy żaden robot nie został jeszcze wskazany.

### A1. 🔴 Zmierzyć to, co w opisie jest `unknown`

**Co dostarczyć:** uzupełniony plik opisu embodimentu, w którym żadne pole nie
ma wartości `"unknown"`.

Wzorzec: `mercato/embodiments/so101_follower.json`. Pola dziś nieznane
z dokumentacji SO-101: `kinematics.payloadKg`, `kinematics.reachMm`.

**Dlaczego:** `validateEmbodimentSpec` rozróżnia opis **poprawny** od
**kompletnego**. Niekompletny wolno zaewidencjonować — nie wolno na nim
dopuścić polityki do ruchu. `"unknown"` jest wartownikiem: istnieje właśnie
po to, żeby brak pomiaru nie dał się pomylić z pomiarem. Wpisanie tam liczby
„z katalogu producenta" jest gorsze niż zostawienie `unknown`, bo zamienia
brak wiedzy w fałszywą wiedzę.

**Kryterium odbioru:**
```
mercato fleet embodiment --file <plik>.json
```
kończy się bez sekcji „Opis NIEKOMPLETNY".

**Uwaga o zakresie:** liczba i rozmieszczenie kamer **nie należą do ramienia** —
to cecha stanowiska. Polityka trenowana z dwiema kamerami nie zadziała na
stanowisku z jedną, ale ten fakt wchodzi do systemu przez konfigurację celi,
nie przez ten plik.

### A2. 🔴 Kontrakt kalibracji: co, czym, jak długo ważne, z jaką niepewnością

**Co dostarczyć:** dla każdej pozycji w `requiredCalibrations` — nazwa
narzędzia, które pomiar produkuje, format wyniku, okres ważności w dniach,
oraz **jak wyrazić niepewność**.

**Dlaczego:** `Calibration.validUntil` jest polem obowiązkowym i nie ma
wartości domyślnej. Kalibracja bez daty ważności to kalibracja, o której nikt
nigdy nie przypomni. Od tej wersji istnieje detektor godzinny, który ogłasza
`fleet.calibration.expired` — ale ogłosi tylko to, czemu ktoś wcześniej nadał
termin.

Pole `uncertainty` jest opcjonalne w schemacie i **nie powinno być puste**
w praktyce: bez niego „skalibrowany" jest słowem, a nie liczbą.

**Kryterium odbioru:** przejście do stanu `ready` na robocie z tą rewizją
nie odbija się komunikatem „Nie można dopuścić robota: brak ważnej
kalibracji …".

### A3. 🔴 Nazwać deterministyczną warstwę bezpieczeństwa

**Co dostarczyć:** wskazanie mechanizmu z **zamkniętego słownika**:

```
hardware_estop | safety_plc | safety_rated_torque_limit
safety_rated_speed_limit | light_curtain | fence_interlock | dual_channel_relay
```

plus opis słowny, gdzie jest zaimplementowany i czy da się go wyłączyć.

**Dlaczego:** zatwierdzenie uzasadnienia bezpieczeństwa wymaga obu:
`safetyLayer` (opis) **i** `safetyLayerKind` (rodzaj ze słownika). Sam wolny
tekst przyjmuje zdanie „warstwą bezpieczeństwa jest model nadzorczy na węźle
obliczeniowym", które brzmi poważnie i **nie jest** warstwą bezpieczeństwa.

Uczona polityka nie jest żadnym z tych mechanizmów i próba zadeklarowania jej
jako funkcji bezpieczeństwa (`declaredAsSafetyFunction: true`) jest odrzucana
przy zatwierdzeniu — wpycha maszynę w Annex I część A rozporządzenia
2023/1230, czyli w ocenę przez jednostkę notyfikowaną, dla której nie istnieje
ustalona metoda wykazania zgodności uczonego modelu.

**Do przemyślenia po waszej stronie:** w SO-101 warstwą jest
`max_relative_target` w sterowniku LeRobot — ograniczenie skoku zadanej
pozycji. Jest deterministyczne, ale **da się je wyłączyć ustawieniem na
`null`** i nie ma kategorii bezpieczeństwa wg ISO 13849. Dla celi ogrodzonej
to może wystarczyć; dla celi współdzielonej z ludźmi — nie. Rozstrzygnięcie
należy do was i do oceny ryzyka stanowiska, nie do tej platformy.

---

## Blok B — kontrakt polityki

### B1. ✅ Zadeklarować przestrzeń obserwacji i akcji

**Co dostarczyć:** `observationDim`, `actionDim`, `trainedDofCount`,
`controlFrequencyHz` oraz uporządkowane `observationSpec.fields` i
`actionSpec.fields`. Każde pole podaje `key`, `size`, `unit`, `frame` oraz
`semantics`:

- **kolejność** wymiarów w wektorze obserwacji i akcji,
- **jednostki** (radiany czy stopnie, metry czy milimetry),
- **układ odniesienia** dla pozycji kartezjańskich,
- **częstotliwość sterowania**, przy której polityka była uczona,
- czy akcje są **absolutne** czy **przyrostowe**.

System sprawdza, czy suma `size` zgadza się z zadeklarowanym wymiarem, czy
klucze nie powtarzają się i czy jednostki oraz semantyka należą do zamkniętych
słowników. Dzięki temu polityka uczona w radianach nie jest już opisana tak
samo jak sterownik podający stopnie, a akcja `delta` nie wygląda jak
`absolute`.

### B2. 🔴 Podać odcisk kontraktu **niezależnie**

**Co dostarczyć:** `declaredSpecDigest` — skrót specyfikacji, pod którą
polityka była trenowana, podany przez wgrywającego.

**Dlaczego:** to nie jest formalność. Odcisk przychodzi od wgrywającego
i jest porównywany z odciskiem rewizji w bazie. Gdyby był odczytywany z bazy,
kontrola porównywałaby wartość samą ze sobą i zawsze przechodziła. Rozjazd
wychodzi **wyłącznie wtedy, gdy obie strony mówią niezależnie**.

Praktycznie: odcisk trzeba zapisać w metadanych przebiegu treningowego
w chwili startu treningu, a nie odtwarzać przy wgrywaniu.

**Kody odmowy, które zobaczycie:** `embodiment_key_mismatch`,
`spec_digest_mismatch`, `dof_mismatch`, `no_embodiment`.

### B3. 🔴 Komplet artefaktów z rolami i skrótami

**Co dostarczyć:** listę artefaktów, każdy z rolą ze słownika
`weights | config | preprocessor | normalizer | metadata`, adresem i skrótem
**sha256 o długości 64 znaków**.

**Dlaczego:** tożsamość wersji polityki niesie skrót treści, nie numer.
Ponowne wgranie tej samej treści jest deduplikowane i **nie emituje
zdarzenia** — czyli potok CI może wgrywać wielokrotnie bez podwajania
automatyzacji. Numer wersji jest tylko etykietą.

### B4. ⚪ Zachowanie przy wygaśnięciu dzierżawy

**Co dostarczyć:** opis tego, co polityka robi, gdy mandat z centrali wygaśnie
i nie da się go odnowić.

**Dlaczego:** kanał stanu pożądanego działa na dzierżawie o ograniczonym
czasie. Robot bez łącza **nie dowie się o odwołaniu przypisania** i będzie
pracował do końca mandatu — to jest projekt, nie luka. Zatrzymanie
natychmiastowe należy do warstwy deterministycznej, która nie przechodzi przez
tę platformę.

Wasza strona musi rozstrzygnąć: czy po wygaśnięciu robot zatrzymuje się
w miejscu, dokańcza chwyt, czy wraca do pozycji bazowej. Każda z tych
odpowiedzi jest dopuszczalna; brak odpowiedzi nie jest.

---

## Blok C — co wytrenować

### C1. 🔴 Polityka per (zadanie, rewizja embodimentu)

Nie „polityka dla tego robota". Egzemplarz nie jest kontraktem.

### C2. ⚪ Odzyskiwanie po błędzie, nie tylko wykonanie

**Co wytrenować:** zachowanie po nieudanym chwycie, po wypadnięciu obiektu,
po natrafieniu na obiekt spoza rozkładu.

**Dlaczego:** moduł zbiorów klasyfikuje epizody na cztery role:

| Rola | Kiedy | Wartość |
| --- | --- | --- |
| `demo` | sukces bez interwencji | podstawa, najłatwiejsza do zebrania |
| `correction` | epizod z interwencją człowieka | **najcenniejsza i najrzadsza** |
| `failure` | porażka bez interwencji | przykład negatywny |
| `holdout` | odłożone na ewaluację | nie do treningu |

Zbiór złożony z samych `demo` ma ten sam licznik epizodów, co zbiór
zrównoważony, i jest bezużyteczny do uczenia odzyskiwania. Dlatego zdarzenie
`datasets.version.built` niesie **ostrzeżenia o składzie**, a nie sam rozmiar.

Wniosek operacyjny dla was: **interwencje trzeba zgłaszać, nie ukrywać.**
Zespół, który optymalizuje wskaźnik „mało interwencji" przez ich
niezgłaszanie, pozbawia się jedynego źródła danych korekcyjnych.

### C3. 🔴 Detektor z zamkniętym słownikiem klas

**Co dostarczyć:** `classVocabulary` — pełna lista klas, które model potrafi
zwrócić, plus `weightsDigest` i `confidenceThreshold` **większy od zera**.

**Dlaczego, twardo:** rejestracja detektora jest odrzucana, jeśli słownik
zawiera klasę pasującą do któregokolwiek z rdzeni:

```
emotion, mood, sentiment, affect, stress_level, fatigue_level, engagement_score,
face_id, facial_recognition, face_embedding, identity,
biometric, gait_id, iris, fingerprint,
ethnicity, race, religion, political, sexual_orientation, union_membership,
gender, age_estimate
```

To jest art. 5 ust. 1 lit. f i g rozporządzenia 2024/1689 (AI Act):
wnioskowanie emocji w miejscu pracy i kategoryzacja biometryczna wg cech
wrażliwych są **zakazane od 2 lutego 2025**, z sankcją do 35 mln EUR albo 7%
światowego obrotu. Dopasowanie idzie po rdzeniu słowa, więc `emotion_happy`
i `facial_emotion` odpadną tak samo jak `emotion`.

Klasa `person` przechodzi, ale **wyłącznie jako obecność**. Liczba ludzi
w celi jest informacją o bezpieczeństwie. Śledzenie osoby, przypisanie do
pracownika albo zliczanie czasu pracy to inny system i inna podstawa prawna —
ten moduł ich nie obsługuje.

Próg ufności równy zeru jest odrzucany osobno: nie daje zliczeń obiektów,
tylko zliczenia hipotez modelu, a te wchodzą potem do triangulacji jako
pełnoprawny świadek.

### C4. ⚪ Tryb cieniowy

**Co wytrenować / przygotować:** możliwość uruchomienia polityki tak, że
liczy i raportuje, ale **nie rusza maszyną**.

**Dlaczego:** wdrożenia etapowe mają tryb `shadow`, który wymaga przypisania
na robocie w stanie `ready` (a nie `operational`). Bez trybu cieniowego
pierwszy etap każdego wdrożenia jest od razu etapem produkcyjnym.

---

## Blok D — dowody, czyli ewaluacja

To jest blok, który najczęściej bywa robiony na końcu i najczęściej decyduje,
czy cokolwiek wolno uruchomić.

### D1. 🔴 Zestawy ewaluacyjne jako artefakt, nie jako notatka

**Co dostarczyć:** dla każdego zestawu — klucz (`suiteKey`), nazwa, liczba
przypadków, i **dla których klas ryzyka jest obowiązkowy**
(`fenced`, `shared`, `public`).

Każdy przebieg musi zwrócić: wynik `pass | fail | error`, liczbę przypadków
zdanych i wszystkich, adres dowodu (`evidenceUri`) i **odcisk specyfikacji
sprzętu, na którym przebieg się odbył**.

**Dlaczego `error` jest traktowany jak `fail`:** zestaw, który się wywrócił,
nie wykazał zgodności — tak samo jak zestaw oblany. System emituje
`safety.run.failed` w obu wypadkach i robi to celowo. Rozdzielenie ich
zachęca do traktowania awarii potoku jako „jeszcze nie porażki", a to jest
nawyk, który kończy się polityką dopuszczoną bez dowodu.

### D2. 🔴 Wiązać dowód z odciskiem sprzętu

Ewaluacja wykonana na innej rewizji embodimentu niż ta, na którą wgrywacie
politykę, nie jest dowodem dla tej rewizji. System to sprawdza przy
`safety.clearance.check`.

### D3. ⚪ Uzgodnić progi bram — domyślne są nasze, nie wasze

Dziś obowiązują:

| Próg | Wartość domyślna | Znaczenie |
| --- | --- | --- |
| `minEpisodes` | 50 | poniżej tego brama mówi `hold`, nie `pass` |
| `maxInterventionRate` | 0,10 | udział epizodów z interwencją |
| `maxSevereRate` | 0,02 | udział interwencji awaryjnych |
| `minSuccessRate` | 0,80 | udział epizodów zakończonych sukcesem |

**To są wartości przyjęte przy budowie modułu, nie wyprowadzone z waszego
zadania.** Dla sortowania odpadów 80% sukcesu może być absurdalnie nisko albo
absurdalnie wysoko — nie wiem, i nikt tego jeszcze nie ustalił. Zadanie:
podać wartości uzasadnione charakterem zadania, razem z uzasadnieniem.

Zwróćcie uwagę, że `hold` **nie jest porażką** — znaczy „za mało dowodów,
żeby zdecydować". Mylenie tego z porażką popycha ludzi do przepychania
wdrożeń przez bramę, która nic jeszcze nie powiedziała.

---

## Blok E — telemetria z hali

### E1. 🔴 Epizody ze stabilnym identyfikatorem zewnętrznym

**Co dostarczyć:** dla każdego wykonania zadania — `externalRef` **stabilny
i powtarzalny**, `taskKey`, `startedAt`, `endedAt`, `outcome` ze słownika
`success | failure | aborted | timeout`.

**Dlaczego `externalRef` musi być stabilny:** jest kluczem idempotencji.
Dosłanie tego samego epizodu po zerwaniu łącza zwraca istniejący rekord
z flagą `duplicate` i **nie emituje zdarzenia** — nie podwaja statystyk i nie
odpala automatyzacji drugi raz. Identyfikator generowany losowo przy każdej
próbie wysyłki niszczy tę własność.

### E2. 🔴 Interwencje ze słownika, z kategorią przyczyny

**Co dostarczyć:** `kind` ze słownika
`adjust | manual_reset | teleop_takeover | abort | estop`,
`reasonCategory` (wspólna lista po waszej stronie — patrz F1),
`reason` (tekst), `occurredAt`, opcjonalnie `recoverySeconds`.

**Dlaczego rodzaj jest zamknięty:** trzy z nich — `estop`, `abort`,
`teleop_takeover` — emitują osobne zdarzenie `episodes.intervention.emergency`,
bo odebranie maszynie sprawczości to inna klasa faktu niż korekta chwytu.
Kanał alarmowy nie może tego rozróżniać dopasowaniem stringa.

`recoverySeconds` jest opcjonalne i **powinno być wypełniane**: to jedyna
miara kosztu interwencji wyrażona w czyimś czasie.

### E3. 🔴 Agent brzegowy: tożsamość kryptograficzna

**Co zaimplementować po waszej stronie:**

- para kluczy **Ed25519** generowana **na maszynie**; klucz prywatny nigdy nie
  opuszcza robota,
- podpisy z prefiksami wiążącymi kontekst: `edge.enroll:`, `edge.connect:`,
  `edge.heartbeat:`, `edge.rotate:`,
- **licznik sekwencji rosnący w obrębie sesji** — nie globalny; restart agenta
  zeruje licznik i otwiera nową sesję,
- obsługa okna rotacji klucza: przez pewien czas ważne są dwa klucze naraz,
- parametry żywotności deklarowane przy wpisaniu:
  `heartbeatIntervalSeconds` (domyślnie 30), `livenessGraceSeconds` (30),
  `lostAfterSeconds` (300), przy czym musi zachodzić
  `lostAfterSeconds > heartbeatIntervalSeconds + livenessGraceSeconds`.

**Punkty wejścia** (jedyne bez uwierzytelnienia sesyjnego — autoryzacja jest
kryptograficzna):

```
POST /api/edge/enroll
POST /api/edge/connect
POST /api/edge/heartbeat
POST /api/deployment/lease
POST /api/deployment/report
```

Uderzenie serca **nie generuje zdarzenia** i nie ma generować. Faktem jest
dopiero jego brak — po przekroczeniu progu ciszy zamiatanie ogłasza
`edge.agent.lost`. Robot dostaje w odpowiedzi na każde uderzenie własny termin
odcięcia (`nextDeadline`), więc może sam zwolnić, gdy centrala zamilknie.

**Numer sekwencji niemalejący jest traktowany jako incydent bezpieczeństwa**,
nie jako zakłócenie sieci: to albo powtórka, albo drugi nadawca z tym samym
kluczem.

### E4. ⚪ Okna detekcji: zadeklarować tryb zliczania

`countingMode` przyjmuje `tracks` albo `detections`. To zmienia znaczenie
liczby, a nie jej dokładność: ta sama butelka widziana przez 30 klatek to
jedna „ścieżka" i trzydzieści „detekcji". Bez deklaracji liczba jest
nieinterpretowalna.

Zliczenia klas spoza `classVocabulary` zarejestrowanego detektora są
odrzucane — oznaczają, że na brzegu działa inny model, niż zapisano
w rejestrze.

---

## Blok F — dokumentacja, której nie ma czym zastąpić

### F1. ✅ Lista kategorii przyczyn interwencji

Zamknięty słownik jest opisany w `physical-ai/INTERVENTION-REASONS.md` i
egzekwowany przez komendę oraz podpisany endpoint edge. `kind` opisuje, co
zrobił operator, a `reasonCategory` — dlaczego; szczegół nadal trafia do
wolnego pola `reason`.

### F2. 🔴 Masa nominalna sztuki

**Co dostarczyć:** dla każdego SKU / frakcji — `nominalPieceGrams`.

**Dlaczego:** most hala ↔ ERP uzgadnia masę zważoną z masą wynikającą ze
zgłoszeń robota. Bez masy nominalnej werdykt brzmi `no_reference` i uzgodnienie
nie ma do czego się odnieść — rozjazd nie zostanie wykryty, a partia będzie
wyglądała na zgodną.

Zastrzeżenie, które warto rozumieć: **rozjazd nie wstrzymuje materiału.** Na
stan idzie masa z wagi, bo waga jest jedynym przyrządem pomiarowym w tym
łańcuchu. Rozjazd jest oceną **maszyny**, nie towaru, i kieruje człowieka do
robota.

### F3. ⚪ Tryby awarii zadania

**Co dostarczyć:** listę sposobów, na jakie to konkretne zadanie potrafi się
nie udać, i co w każdym wypadku znaczy „interwencja".

Bez tego `outcome: failure` i `kind: adjust` są etykietami bez treści, a każde
zestawienie zbudowane na nich jest zestawieniem cudzych domysłów.

### F4. ⚪ Reprodukowalność przebiegu treningowego

**Co dostarczyć:** `runRef` (stabilny identyfikator przebiegu po waszej
stronie), framework, hiperparametry, wersja zbioru.

**Dlaczego:** domknięcie przebiegu (`datasets.runs.complete`) jest **jedynym
miejscem w całym systemie**, w którym powstaje wiązanie wersja zbioru ↔ wersja
polityki. Przebieg zakończony sukcesem bez wskazanej wersji polityki jest
odrzucany, bo byłby dziurą w pętli: zbiór stałby się źródłem czegoś, czego nie
da się wskazać.

---

## Czego **nie** musicie robić

Warto powiedzieć wprost, żeby nie robić roboty, której nikt nie odbierze:

- **Nie musicie wyliczać odcisku specyfikacji ręcznie.** Robi to
  `mercato fleet embodiment`. Pole `provenance` i `name` są z odcisku
  wyłączone celowo — poprawka literówki w nazwie nie ma unieważniać kontraktu.
- **Nie musicie budować własnego rejestru wersji polityk.** Numerowanie,
  deduplikacja po treści i historia statusów są po naszej stronie.
- **Nie musicie liczyć wskaźników bramy.** Brama liczy je sama z księgi
  epizodów. Wasze zadanie to rzetelnie zgłaszać epizody i interwencje.
- **Nie musicie implementować logiki kwarantanny.** Moduł brzegowy stwierdza
  ciszę i ją ogłasza; decyzja o wycofaniu maszyny z pracy należy do człowieka
  i do modułu floty.
- **Nie róbcie własnego kasowania nagrań.** Platforma **oznacza** materiał po
  terminie ustawowym i czeka na potwierdzenie usunięcia od tego, kto trzyma
  bajty. Jeśli to wy trzymacie magazyn obiektów — patrz zadanie G2 niżej.

---

## Czego nasz system jeszcze **nie przyjmie** — dług po naszej stronie

Uczciwie, żeby nie odkryli tego w trakcie integracji:

### G1. ✅ Podpisany endpoint HTTP do wgrywania telemetrii

`POST /api/edge/telemetry` przyjmuje epizod, interwencję albo zagregowane
okno detekcji. Cała koperta jest podpisana Ed25519, rodzaj i treść są związane
z podpisem, a wspólny z heartbeatami numer kolejny odrzuca powtórki. Zakres
organizacji, tenant i robot są wyprowadzane z sesji — nie są przyjmowane od
agenta. Surowe wideo i tensory pozostają w hubie edge/DGX. Format podpisu i
zasady ponowień opisuje `physical-ai/EDGE-TELEMETRY.md`.

### G2. Potwierdzenie usunięcia nagrań wymaga wywołania z waszej strony

Jeśli magazyn obiektów jest u was, ktoś po waszej stronie musi wołać
`vision.clips.confirm_deletion` (dziś: `mercato vision confirm`) po faktycznym
skasowaniu bajtów. Bez tego licznik „oznaczone i nieusunięte" rośnie, a system
ogłasza `vision.clips.deletion_overdue` — codziennie, dopóki stan trwa.

### G3. ✅ `reasonCategory` ma zamknięty słownik

Patrz F1 oraz `physical-ai/INTERVENTION-REASONS.md`.

### G4. ✅ Kolejność, jednostki i układy odniesienia są kontraktem strukturalnym

Patrz B1. Nowe wersje polityk wymagają uporządkowanych specyfikacji wektorów,
jednostek, układów odniesienia, semantyki oraz częstotliwości sterowania.
Wersje historyczne zachowują puste pola — system nie dopisuje im zmyślonych
kontraktów.

---

## Definicja gotowości

Jedna rewizja embodimentu i jedna polityka są „gotowe do wdrożenia", gdy:

- [ ] `mercato fleet embodiment` nie zgłasza niekompletności (A1)
- [ ] każda wymagana kalibracja ma narzędzie, termin ważności i niepewność (A2)
- [ ] warstwa bezpieczeństwa ma rodzaj ze słownika (A3)
- [ ] polityka wgrana z `declaredSpecDigest` zgodnym z rewizją (B2, B3)
- [ ] zestawy ewaluacyjne zdefiniowane i przebiegi zapisane z dowodem (D1, D2)
- [ ] uzasadnienie bezpieczeństwa zatwierdzone dla tej klasy celi (A3, D2)
- [ ] progi bramy uzgodnione i uzasadnione zadaniem (D3)
- [ ] agent brzegowy przechodzi pełną ścieżkę: bilet → wpis → połączenie →
      uderzenie serca → dzierżawa → raport stanu (E3)
- [ ] masa nominalna sztuki podana dla wszystkich obsługiwanych frakcji (F2)

Sprawdzenie stanu w dowolnej chwili:

```
mercato fleet status        # ile rejestr twierdzi, że istnieje, i ile wolno uruchomić
mercato fleet expiry        # co straciło ważność od ostatniego przebiegu
mercato edge status         # kto się odzywa, a kto milczy
```

---

## Uwaga na koniec, szczera

Największe ryzyko w tej integracji **nie leży** w żadnej pozycji powyżej.
Leży w B1: w tym, że przestrzeń obserwacji i akcji jest dziś kontraktem
słownym. Wszystkie twarde bramki, które zbudowaliśmy — odcisk specyfikacji,
zgodność DOF, kalibracja, uzasadnienie bezpieczeństwa — przepuszczą politykę,
która liczy w złych jednostkach.

Jeżeli macie pomysł, jak to zamknąć maszynowo, jest to ważniejsze niż
którakolwiek pozycja z bloku F.

# GREG_HANDOFF — domknięcie SO-101 end-to-end z walidacją fizyczną

Dokument dla zespołu physical. Opisuje **dokładnie**, co musi zostać wykonane
na podłączonym SO-101, jakie dane wrócić do ERP i co musi przejść, żebyśmy
mogli uczciwie powiedzieć: *wtyczka Physical AI działa end-to-end i jest
zwalidowana fizycznie*.

Nic tutaj nie jest oceną dotychczasowej pracy. Materiał z hackathonu
(`mercatoXD`) powstał w większości przed naszą specyfikacją i dotyczył A1X —
inwentaryzacja jest w
[`physical-ai/MATERIAL-MERCATOXD.md`](physical-ai/MATERIAL-MERCATOXD.md).
Ten dokument dotyczy **SO-101**, do którego mamy teraz dostęp.

---

## 0. Definicja zaliczenia

Mówimy „end-to-end z walidacją fizyczną" wtedy i tylko wtedy, gdy **wszystkie
osiem** warunków jest spełnionych jednocześnie, każdy z dowodem w bazie:

| # | Warunek | Gdzie jest dowód |
| --- | --- | --- |
| Z1 | Rewizja embodimentu `so101_follower` r2 ma `verifiedAgainstHardware: true` i skrót zapieczętowanego raportu odbioru | `fleet_embodiment_revisions` |
| Z2 | Robot zarejestrowany, ma ważną kalibrację `joint_offsets` z niepewnością, i jest w stanie `operational` | `fleet_robots`, `fleet_calibrations` |
| Z3 | Agent edge przeszedł `enroll` → `connect` → ≥ 100 kolejnych `heartbeat` bez luki w sekwencji, podpisany Ed25519 | `edge_agent_sessions` |
| Z4 | Wersja polityki zarejestrowana z `observationSpec`, `actionSpec`, `declaredSpecDigest` i skrótami prawdziwych plików wag | `policy_registry_policy_versions`, `..._artifacts` |
| Z5 | Uzasadnienie bezpieczeństwa **zatwierdzone** dla klasy celi, z prawdziwym `safetyLayerKind`, i `safety.clearance.check` zwraca `cleared: true` | `safety_cases`, `safety_eval_runs` |
| Z6 | Robot pobrał dzierżawę podpisanym żądaniem i raportuje stan; `deployment` pokazuje zbieżność (`converged`) | `deployment_assignments`, `deployment_state_reports` |
| Z7 | ≥ 50 epizodów i komplet interwencji dotarł podpisanym kanałem `/api/edge/telemetry`; liczby w ERP zgadzają się z licznikiem lokalnym agenta | `episodes_episodes`, `episodes_interventions` |
| Z8 | Rollout przeszedł etap `shadow`, a brama `rollout.gates.evaluate` orzekła `advance` na liczbach, nie ręcznie | `rollout_stages`, `rollout_gate_evaluations` |

**Warunek wstępny dla całości — i jedyna rzecz, która może to zablokować na
starcie:** SO-101 w obecnej postaci **nie ma deterministycznej warstwy
zatrzymania**. Jedyne, co opisuje jego kontrakt, to `max_relative_target`
w sterowniku LeRobot: `disableable: true`, realizowane poza platformą, więc
z definicji nie jest funkcją bezpieczeństwa. Nasz słownik `safetyLayerKind`
przyjmuje wyłącznie:

```
hardware_estop, safety_plc, safety_rated_torque_limit,
safety_rated_speed_limit, light_curtain, fence_interlock, dual_channel_relay
```

Konsekwencja praktyczna: **bez podłączonego sprzętowego E-stopu (albo
przekaźnika dwukanałowego) nie da się prawdziwie wypełnić uzasadnienia, a Z5
nie przejdzie.** Nie ma tu obejścia i nie szukajcie go — pole `safetyLayer`
jako wolny tekst istnieje, ale samo nie wystarcza. Minimum, które akceptujemy:
przerywacz zasilania napędów w torze dwukanałowym, z pomiarem czasu
zatrzymania. Cela musi być zgłoszona jako `fenced`; `shared` (praca obok
ludzi) nie wchodzi w grę na tym sprzęcie.

---

## 1. Co już działa po naszej stronie

Endpointy gotowe i otestowane (154 zestawy, 1376 testów zielonych,
`typecheck` czysty):

| Ścieżka | Kto woła | Uwierzytelnienie |
| --- | --- | --- |
| `POST /api/edge/enroll` | agent, raz | bilet + podpis nowym kluczem |
| `POST /api/edge/connect` | agent, po restarcie | podpis Ed25519 |
| `POST /api/edge/heartbeat` | agent, cyklicznie | podpis Ed25519 |
| `POST /api/edge/telemetry` | agent | podpis Ed25519 |
| `POST /api/deployment/lease` | agent | podpis Ed25519 |
| `POST /api/deployment/report` | agent | podpis Ed25519 |
| `POST /api/fleet/robots/transition` | człowiek (UI) | sesja + `fleet.transition` |
| `POST /api/fleet/calibrations` | człowiek (UI) | sesja + `fleet.calibrate` |
| `POST /api/safety/incidents` | człowiek (UI) | sesja + `safety.incidents.report` |
| `GET /api/fleet/robots`, `/api/fleet/robots/{id}` | UI | sesja + `fleet.view` |

Narzędzie odbioru sprzętowego: `mercato/hardware/so101/validate.py`
(pełna procedura: `mercato/hardware/so101/README.md`).

---

## 2. Etap A — odbiór sprzętowy SO-101

Wykonać dokładnie procedurę z `mercato/hardware/so101/README.md`. Poniżej to,
co musi z niej wyjść, z kryteriami zaliczenia.

### A1. Magistrala (`scan`, `inspect`)
- **Zwrócić:** port, sześć serw STS3215 o ID 1–6, model i wersja firmware każdego.
- **Zalicza:** dokładnie sześć serw, żadnego duplikatu ID.
- **Uwaga:** `inspect` nie zmienia `Torque_Enable`. Jeśli zmienia — zgłoście, to błąd narzędzia.

### A2. Kalibracja (`calibrate`)
- **Zwrócić:** per staw `id`, `drive_mode`, `homing_offset`, `range_min`, `range_max`; SHA-256 pliku kalibracji LeRobot; `--valid-days`; **`--uncertainty-deg` zmierzone lub uzasadnione, nie zgadnięte**.
- **Zalicza:** odczyt z EEPROM, nie z pliku; niepewność podana jawnie.
- **Uwaga:** ważność jest też zdarzeniowa — wymiana serwa, ponowny montaż orczyka, kolizja lub zmiana `drive_mode` unieważnia dowód przed datą. Wtedy natychmiast powtórka i nowy rekord w ERP.

### A3. Zasięg i udźwig (`measure`)
- **Zwrócić:** `reachMm`, `payloadKg`, obie niepewności, numery seryjne przyrządów, operator, opis metody (poza, kryterium utrzymania 30 s).
- **Zalicza:** wartość zmierzona. **Wartość katalogowa jest odrzucana** — w kontrakcie embodimentu te pola stoją dziś jako `"unknown"` i mają zostać zastąpione pomiarem.

### A4. Zasilanie (`power`)
- **Zwrócić:** zakres oczekiwany z **realnego zasilacza tego zestawu**, napięcie na biegu jałowym i pod obciążeniem, przyrząd, metoda, URI dowodu.
- **Zalicza:** pomiar mieści się w zadeklarowanym zakresie.

### A5. Zwolnienie momentu (`torque-off`)
- **Zwrócić:** `Torque_Enable == 0` na wszystkich sześciu serwach.
- **Zalicza:** wszystkie sześć. **To nie jest E-stop** i nie zalicza A6.

### A6. E-stop i limity lokalne (`safety`) — **krok krytyczny**
- **Zwrócić:** `--mechanism` z zamkniętego słownika, `--bypassable` opisujące **rzeczywiste okablowanie**, zmierzony `--stop-time-ms`, scenariusze `idle,motion,grasp`, testy limitów `position,speed,command_timeout`, nazwa sterownika bezpieczeństwa, procedura resetu, URI dowodu (wideo).
- **Zalicza:** każdy z trzech scenariuszy i każdy z trzech limitów zaliczony osobno; czas zatrzymania > 0 i zmierzony, nie założony.
- **Uwaga:** jeśli `bypassable = true`, zapisujemy to i to nie dyskwalifikuje dowodu — ale ląduje w uzasadnieniu i ogranicza klasę celi.

### A7. Zapieczętowanie i rewizja (`seal`, `finalize`)
- **Zwrócić:** `evidence.sealed.json`, jego SHA-256 policzony przez narzędzie, `runRef`, oraz `so101_follower.r2.json`.
- **Zalicza:** `finalize` przechodzi. Odmówi, jeśli którykolwiek z dowodów A1–A6 nie ma statusu `passed`; to jest celowe.

---

## 3. Etap B — wejście do ERP

### B1. Rewizja embodimentu
Wgrać `so101_follower.r2.json` jako nową rewizję. Ma zawierać zmierzone
`reachMm` i `payloadKg`, `verifiedAgainstHardware: true`, skrót zapieczętowanego
raportu i `runRef`.
**Zapamiętać `specDigest` tej rewizji — będzie potrzebny w B4 jako
`declaredSpecDigest`.**

### B2. Rejestracja robota — `fleet.robots.register`
```json
{ "serialNumber": "...", "name": "...", "embodimentRevisionId": "<uuid r2>",
  "ownerOrganizationId": "<uuid>", "operatorOrganizationId": "<uuid>",
  "cellId": "<uuid>" }
```
Właściciel i operator są **osobno i oba wymagane** — brak wartości domyślnej
jest zamierzony.

### B3. Kalibracja — `POST /api/fleet/calibrations`
```json
{ "robotId": "<uuid>", "kind": "joint_offsets",
  "measuredAt": "<ISO>", "validUntil": "<ISO>",
  "values": { "<per-staw z A2>": ... },
  "uncertainty": { "offsetDeg": 0.5 } }
```
Bez ważnej kalibracji `joint_offsets` przejście robota do `ready` /
`operational` zostanie **odrzucone z kodem 422** i komunikatem wskazującym
brakujący rodzaj. To jest zaprojektowane zachowanie i jeden z testów odbioru
(patrz §7, T3).

### B4. Wersja polityki — `policy_registry.versions.register`
To jest miejsce, w którym najłatwiej o rozjazd, więc opisuję pełnym polem:

```json
{
  "policyId": "<uuid>",
  "embodimentRevisionId": "<uuid r2>",
  "declaredSpecDigest": "<specDigest z B1, wzięty z metadanych ROZPOCZĘTEGO treningu>",
  "observationDim": 6,
  "actionDim": 6,
  "trainedDofCount": 6,
  "controlFrequencyHz": 30,
  "leaseExpiryBehavior": "hold_position",
  "observationSpec": { "fields": [
    { "key": "joint.position", "size": 6, "unit": "rad", "frame": "joint_space", "semantics": "absolute" }
  ]},
  "actionSpec": { "fields": [
    { "key": "joint.target", "size": 6, "unit": "rad", "frame": "joint_space", "semantics": "absolute" }
  ]},
  "artifacts": [
    { "role": "weights", "uri": "s3://...", "digest": "<sha256, 64 znaki hex>",
      "sizeBytes": 123456, "mediaType": "application/octet-stream" }
  ],
  "provenance": { "framework": "LeRobot 0.6.1", "datasetVersion": "...", "trainingRunRef": "..." }
}
```

Reguły, które wymusza kod:
- `unit` tylko z listy: `rad, deg, m, mm, m/s, mm/s, rad/s, deg/s, N, N*m, kg, s, normalized, boolean, pixel, unitless`;
- `semantics` tylko z listy: `absolute, delta, velocity, effort, binary, encoded`;
- `frame` jawny zawsze, również `joint_space` i `none`;
- suma `size` pól musi się równać `observationDim` / `actionDim`;
- `leaseExpiryBehavior` tylko: `hold_position`, `complete_grasp_then_hold`, `return_home`;
- `role` artefaktu tylko: `weights`, `config`, `preprocessor`, `normalizer`, `metadata`; `digest` to dokładnie 64 znaki hex (SHA-256), pole nazywa się `digest`, nie `sha256`;
- `declaredSpecDigest` **musi pochodzić z metadanych treningu**, nie być wyliczony ponownie przy wgrywaniu. Jeśli polityka była uczona pod inną rewizję embodimentu, chcemy to zobaczyć jako rozjazd, a nie zamaskować.

**Jeśli kamera wchodzi do obserwacji** — dodajcie ją jawnie jako pole
z `unit: "pixel"` i `frame` nazywającym umocowanie. Liczba i rozmieszczenie
kamer nie należą do ramienia, tylko do stanowiska: polityka uczona z dwiema
kamerami nie zadziała na stanowisku z jedną, a kontrakt ma to wyłapać przed
uruchomieniem, nie po.

---

## 4. Etap C — agent edge (Ed25519)

Klucz prywatny **nigdy nie opuszcza robota**. Centrala zna tylko publiczny.

### C1. Wpis — `POST /api/edge/enroll`
```
podpisywany tekst: edge.enroll:<token>:<fingerprint>
```
`fingerprint` = SHA-256 klucza publicznego w postaci **DER/SPKI** (nie z tekstu PEM).
```json
{ "token": "...", "publicKey": "<PEM>", "signature": "<base64>",
  "agentKind": "onboard", "agentVersion": "...",
  "heartbeatIntervalSeconds": 30, "livenessGraceSeconds": 30, "lostAfterSeconds": 300 }
```
Zwraca: `agentId`, `robotId`, `sessionId`, `fingerprint`.
**Odcisk trzeba porównać na ekranie robota** — dlatego liczymy go z DER.

### C2. Połączenie — `POST /api/edge/connect`
```
podpisywany tekst: edge.connect:<agentId>:<timestampISO>
```
Znacznik czasu poza dopuszczalnym rozjazdem zegarów → odmowa. Zsynchronizujcie NTP.

### C3. Uderzenie serca — `POST /api/edge/heartbeat`
```
podpisywany tekst: edge.heartbeat:<sessionId>:<sequence>:<timestampISO>
```
`sequence` **rosnąca, bez luk**. Powtórzona sekwencja jest odtworzeniem i zostanie odrzucona.

### C4. Rotacja klucza — podpisywana **nowym** kluczem
```
podpisywany tekst: edge.rotate:<agentId>:<fingerprint nowego klucza>
```
Dowodem jest posiadanie następcy, nie poprzednika. Okno zakładkowe jest
obsłużone: stary klucz weryfikuje do `activeUntil`.

**Do zwrócenia nam:** `agentId`, `sessionId`, odcisk klucza, dowód ≥ 100
kolejnych heartbeatów bez luki, oraz wynik celowej próby odtworzenia (replay)
— musi zostać odrzucona.

---

## 5. Etap D — dzierżawa i stan pożądany

Model jest **odwrotny** niż kolejka zadań: ERP publikuje stan pożądany, robot
go pobiera i raportuje, co faktycznie robi.

### D1. `POST /api/deployment/lease`
```
podpisywany tekst: deployment.lease:<sessionId>:<sequence>:<timestampISO>
```
Treść żądania (na drucie klucz nazywa się `sessionId`, nie `agentSessionId`):
```json
{ "sessionId": "<uuid>", "sequence": 1,
  "timestamp": "<ISO>", "signature": "<base64>" }
```
`sequence` **rosnąca per sesja**, osobny licznik niż heartbeat. Zwraca
przydział: wersję polityki, jej artefakty, `leaseExpiryBehavior` i **czas
ważności dzierżawy**.

### D2. `POST /api/deployment/report`
```
podpisywany tekst: deployment.report:<sessionId>:<reportedState>:<timestampISO>
```
```json
{ "sessionId": "<uuid>",
  "reportedState": "running" | "stopped",
  "reportedPolicyVersionId": "<uuid>" | null,
  "timestamp": "<ISO>", "signature": "<base64>" }
```
> **Zmiana z 2026-09-20.** Do wczoraj ten endpoint sprawdzał wyłącznie, czy
> sesja istnieje — czyli znajomość `sessionId` wystarczała, żeby wmówić
> centrali dowolny stan maszyny. Poprawione: zgłoszenie jest teraz podpisywane
> tak samo jak dzierżawa, z własnym przedrostkiem (podpis dzierżawy tu nie
> przejdzie i odwrotnie). Jeśli pisaliście agenta wcześniej niż dziś,
> **to jest jedyna zmiana kontraktu, którą trzeba nanieść.**

**Przedrostki są różne celowo.** Podpis zebrany przy uderzeniu serca nie może
być przedstawiony jako żądanie dzierżawy ani jako zgłoszenie stanu.

### D3. Zachowanie po wygaśnięciu dzierżawy — **do przetestowania fizycznie**
Agent ma zrealizować `leaseExpiryBehavior` z wersji polityki. Test: odciąć
sieć w trakcie ruchu i sprawdzić, czy ramię robi dokładnie to, co
zadeklarowano (`hold_position` / `complete_grasp_then_hold` / `return_home`).
**Do zwrócenia:** wideo i zmierzony czas od utraty łączności do osiągnięcia
zadeklarowanego zachowania.

**Rozjazd między stanem pożądanym a raportowanym** jest wykrywany zboczem
(zmiana werdyktu), nie co raport — więc nie zalejecie nas zdarzeniami.

---

## 6. Etap E — telemetria

Jeden endpoint, pięć rodzajów: `POST /api/edge/telemetry`.

```
podpisywany tekst:
edge.telemetry:<sessionId>:<sequence>:<timestampISO>:<kind>:<sha256(canonicalJson(payload))>
```

`canonicalJson` = JSON z **kluczami posortowanymi na każdym poziomie**
(kolejność tablic pozostaje znacząca), bez `undefined`, bez `NaN`
i nieskończoności. Referencja: `mercato/modules/edge/lib/crypto.ts`.

Koperta wspólna: `{ sessionId, sequence, timestamp, signature, kind, payload }`.

### E1. `kind: "episode"`
```json
{ "externalRef": "<idempotencja — wasz identyfikator epizodu>",
  "taskKey": "sort-plastic", "startedAt": "<ISO>", "endedAt": "<ISO>",
  "outcome": "success" | "failure" | "aborted" | "timeout",
  "outcomeDetail": "...", "policyVersionId": "<uuid>",
  "cellId": "<uuid>", "assignmentId": "<uuid>",
  "metrics": { "cycleTimeS": 12.4, "graspAttempts": 2 } }
```
`externalRef` jest kluczem idempotencji — powtórzone wysłanie tego samego
epizodu nie utworzy duplikatu.

### E2. `kind: "intervention"`
```json
{ "episodeId": "<uuid>|null",
  "kind": "adjust" | "manual_reset" | "teleop_takeover" | "abort" | "estop",
  "stage": "approach", "reasonCategory": "<ze słownika>",
  "reason": "opis po ludzku", "occurredAt": "<ISO>",
  "recoverySeconds": 42, "notes": "..." }
```
`reasonCategory` — **słownik zamknięty**, wybierzcie z listy:
```
grasp_failure, object_not_detected, workspace_obstruction,
person_in_safety_zone, policy_stall, unsafe_motion, joint_limit,
camera_fault, tracking_loss, material_jam, power_fault, hardware_fault,
communications_loss, calibration_error, operator_request, other
```
**Jeśli czegoś brakuje — powiedzcie, dopiszemy.** Lepiej rozszerzyć słownik
niż zalać go wartością `other`; `other` z kilkuset wystąpieniami znaczy, że
lista jest zła, a nie że przypadki są nietypowe.

### E3. `kind: "detection_window"`
```json
{ "cameraId": "<uuid>", "detectorVersionId": "<uuid>",
  "startedAt": "<ISO>", "endedAt": "<ISO>", "framesAnalyzed": 9000,
  "countingMode": "tracks" | "detections",
  "counts": { "pet": 412, "hdpe": 88 },
  "meanConfidence": { "pet": 0.91, "hdpe": 0.78 } }
```
`countingMode` jest wymagany, bo „412 śladów" i „412 detekcji" to dwie różne
liczby i mylenie ich psuje bilans masy.

### E4. `kind: "clip"` i `kind: "clip_deletion_confirmation"`
ERP przechowuje **URI, metadane i skróty nagrań — nigdy bajtów wideo**.
Nagranie z osobą w kadrze ma trzymiesięczny limit retencji (art. 22² Kodeksu
pracy); po usunięciu pliku wyślijcie potwierdzenie `clip_deletion_confirmation`
z listą `clipIds`. Brak potwierdzenia w terminie generuje u nas alarm i on
**nie ucichnie sam** — to jedyne zdarzenie, które celowo powtarzamy przy
każdym przebiegu.

---

## 7. Etap F — co musi zostać przetestowane i zwalidowane

Poniższe testy wykonujemy **wspólnie, na podłączonym robocie**, i każdy ma
dać zapis w bazie. To jest właściwa treść „walidacji fizycznej".

| Nr | Test | Kryterium zaliczenia | Dowód |
| --- | --- | --- | --- |
| T1 | Odbiór A1–A7 | `finalize` tworzy r2 z `verifiedAgainstHardware: true` | `evidence.sealed.json` + SHA-256 |
| T2 | Rejestracja i kalibracja | robot widoczny w `/api/fleet/robots`, `calibrationState: "valid"` | zrzut odpowiedzi API |
| T3 | **Odmowa dopuszczenia** — próba przejścia do `operational` przy wygaszonej kalibracji | HTTP **422**, komunikat nazywa brakujący rodzaj, **stan robota bez zmian** | log + rekord w `fleet_robot_transitions` (ma go NIE być) |
| T4 | Bramka podpisu | przejście wymagające zatwierdzenia bez `approvedBy` → odmowa; z `approvedBy` → wpis z aktorem w dzienniku | dziennik audytu |
| T5 | Wpis agenta i odcisk | odcisk z ekranu robota == odcisk w ERP | zdjęcie ekranu + rekord |
| T6 | **Odtworzenie (replay)** | powtórzona sekwencja heartbeatu odrzucona | log odpowiedzi |
| T7 | **Podszycie się** | żądanie z poprawnym `agentId`, ale cudzym/nieprawidłowym podpisem → odrzucone | log odpowiedzi |
| T8 | Ciągłość | ≥ 100 heartbeatów bez luki w sekwencji, potem wymuszony restart agenta i `connect` | `edge_agent_sessions` |
| T9 | Rotacja klucza | podpis nowym kluczem przyjęty, stary działa do `activeUntil`, po tym odrzucany | log |
| T10 | Dzierżawa | agent pobiera przydział, podpisany `report` daje `converged` | `deployment_state_reports` |
| T10b | **Zgłoszenie stanu bez podpisu** | żądanie z samym `sessionId` odrzucone; podpis dzierżawy podstawiony pod raport też odrzucony | log odpowiedzi |
| T11 | **Wygaśnięcie dzierżawy** | odcięcie sieci w ruchu → ramię realizuje zadeklarowany `leaseExpiryBehavior` | wideo + zmierzony czas |
| T12 | Kontrakt polityki | próba rejestracji wersji z `actionDim` niezgodnym z sumą `size` → odmowa | log |
| T13 | **Niezgodność embodimentu** | wersja polityki z `declaredSpecDigest` innym niż rewizja → `clearance` nie przechodzi | werdykt `safety.clearance.check` |
| T14 | Uzasadnienie bezpieczeństwa | `safety.cases.draft` z prawdziwym `safetyLayerKind`, zatwierdzenie, `clearance.check` → `cleared: true` | `safety_cases` |
| T15 | **Polityka jako funkcja bezpieczeństwa** | ustawienie `declaredAsSafetyFunction: true` → `clearance` odmawia **niezależnie od wszystkich zaliczonych testów** | werdykt |
| T16 | Telemetria epizodów | ≥ 50 epizodów; liczba w ERP == licznik lokalny agenta | porównanie |
| T17 | Idempotencja | ten sam `externalRef` wysłany dwa razy → jeden rekord | zapytanie do bazy |
| T18 | Interwencje | każda interwencja z kategorią ze słownika; zero `other` bez uzasadnienia | `episodes_interventions` |
| T19 | Incydent | zgłoszenie incydentu przez UI; `haltDeployment` widoczny dla zgłaszającego | zrzut ekranu |
| T20 | Retencja | klip z osobą → potwierdzenie usunięcia w terminie → alarm gaśnie | `vision_clips` |
| T21 | Rollout shadow | etap `shadow` z ≥ 50 epizodów; `gates.evaluate` → `advance` na liczbach | `rollout_gate_evaluations` |
| T22 | **Wycofanie przez bramę** | sztucznie podbić udział interwencji ciężkich > 2% → brama orzeka `rollback`, etap zmienia status | rekord etapu |

Progi domyślne bramy (można nadpisać per etap, ale domyślne są sensowne):
`minEpisodes: 50`, `maxInterventionRate: 0.10`, `maxSevereRate: 0.02`
(`estop` + `abort`), `minSuccessRate: 0.80`.

**Za mało danych to nie jest zgoda.** Etap poniżej `minEpisodes` dostaje
`hold`, nie `advance` — zero interwencji na trzech epizodach nie jest dowodem
niczego.

---

## 8. Co dokładnie wraca do nas

Lista zamknięta. To jest „done" dla tego handoffu:

1. `evidence.sealed.json` + jego SHA-256 + `runRef` (z A7).
2. `so101_follower.r2.json` ze zmierzonymi `reachMm` i `payloadKg`.
3. Plik kalibracji LeRobot + jego SHA-256 + zmierzona niepewność w stopniach.
4. Wideo: E-stop w trzech scenariuszach, limity, wygaśnięcie dzierżawy (T11).
5. Zmierzony czas zatrzymania E-stopu w ms i deklaracja `bypassable`.
6. `agentId`, `sessionId`, odcisk klucza publicznego (DER/SPKI, hex).
7. Wagi polityki + `config`, `metadata`, `preprocessor`, `normalizer`:
   docelowe URI i SHA-256 każdego pliku.
8. `declaredSpecDigest` **z metadanych rozpoczętego treningu**.
9. Wersja datasetu, `trainingRunRef`, framework i wersja, hiperparametry.
10. Zestaw ewaluacyjny: klucz suite'u, liczba przypadków, wynik, `evidenceUri`.
11. Eksport epizodów i interwencji z licznika lokalnego agenta — do porównania z ERP (T16).
12. Lista brakujących kategorii `reasonCategory`, jeśli takie wyszły w praniu.

---

## 9. Granice — czego platforma nie robi i nie będzie robić

Żeby nie było nieporozumienia przy projektowaniu agenta:

- **ERP nie zatrzymuje ramienia.** Natychmiastowe zatrzymanie należy do
  lokalnej warstwy deterministycznej. Endpoint, który „przerywa" zadanie,
  oznacza rekord — nie hamuje maszyny. Jeśli wasz agent zakłada, że centrala
  zatrzyma robota, to założenie jest błędne i trzeba je usunąć z projektu.
- **ERP nie steruje i nie uczy.** Nie przechodzą przez nas trajektorie,
  tensory ani obraz. Przechodzą fakty: epizody, interwencje, liczniki.
- **Polityka nie może być funkcją bezpieczeństwa.** Deklaracja
  `declaredAsSafetyFunction: true` blokuje dopuszczenie i jest to blokada
  nieprzekraczalna kompletem zaliczonych testów. Powód: wpycha maszynę
  w Annex I część A rozporządzenia 2023/1230, czyli w ocenę przez jednostkę
  notyfikowaną, dla której nie ma ustalonej metody wykazania zgodności.
- **Przycisk w aplikacji nie jest E-stopem.** Nigdy nim nie będzie.

---

## 10. Pułapki z materiału hackathonowego, które warto przenieść

Dotyczą A1X, ale kosztowały czas i mogą się powtórzyć:

- **Załączenie bez trzymania `p_des = q`** dało ruch **76,36°** przy
  nasyconym wysiłku. Reguła bezpiecznego załączania (utrzymuj zadaną równą
  bieżącej w chwili włączenia momentu) ma być w agencie od pierwszej wersji,
  a nie dopisana po incydencie.
- `kp = 0` potrafi spowodować odrzucenie całej ramki i wymagać restartu zasilania.
- Kod funkcyjny wyłączający moment potrafi **zamrozić telemetrię** — martwy
  odczyt nie znaczy martwej maszyny.
- Testy na atrapach nie są dowodem zachowania sprzętu. 56/56 zielonych
  i nieudany autonomiczny chwyt współistniały bez sprzeczności.

---

## 11. Kolejność i zależności

```
A1..A7 (odbiór)  →  B1 (rewizja r2)  →  B2 (robot)  →  B3 (kalibracja)
                                                          ↓
                    C1..C4 (agent edge)  ←──────────  T3/T4 (odmowy)
                          ↓
                    B4 (wersja polityki)  →  E (uzasadnienie, T14/T15)
                          ↓
                    D1..D3 (dzierżawa, T10/T11)
                          ↓
                    E1..E4 (telemetria, T16..T20)
                          ↓
                    F (rollout shadow → brama, T21/T22)
```

Blokery, które zatrzymują wszystko poniżej siebie:
1. **brak sprzętowego E-stopu** → stoi Z5, a z nim całe dopuszczenie;
2. brak zmierzonych `reachMm` / `payloadKg` → `finalize` odmawia, nie ma r2;
3. `declaredSpecDigest` wyliczony po fakcie zamiast wzięty z treningu → T13
   przechodzi fałszywie i cała reszta jest niewiele warta.

Pytania i braki w słownikach — do nas, od razu. Rozszerzenie zamkniętej listy
jest tanie; wartość `other` w produkcji jest droga.

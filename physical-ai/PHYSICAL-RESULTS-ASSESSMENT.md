# Ocena wyników zespołu physical z `mercatoXD`

Źródło: commit `fd5fe08f24ae35fe37c8053086327fdc1a14363a`, utworzony
**2026-09-19 21:37:49 +02:00**. Pełny dozwolony snapshot oraz pochodzenie są w
[`evidence/hackathon-2026-09-18-19/mercatoXD`](evidence/hackathon-2026-09-18-19/mercatoXD/README.md).

## Werdykt

Repo dostarcza wartościowy, działający programowo stos A1X oraz szczegółowy
raport eksperymentalny. Nie dostarcza jednak dowodu gotowego autonomicznego
chwytu ani kompletu dowodów wymaganych przez `HANDOFF-PHYSICAL.md`.

Źródłowy bridge przeszedł **56/56 testów** bez sprzętu i ma 84% pokrycia
instrukcji. Testy używają atrap. Samo repo stwierdza, że G0.5 w żadnej
obserwowanej próbie nie wyemitował akcji chwytaka, a chwyt jest zamykany
skryptem. Tego wyniku nie wolno opisywać jako zaliczonego autonomicznego picku.

## Co zostało rzeczywiście wykazane

- A1X przyjmuje pozycje przez CAN-FD; w kontrolowanej próbie ruch osiągnął
  około 98–102% zadanego kroku.
- Zmapowano kody funkcyjne 1–6. Kod 2 wyłącza moment, ale zamraża telemetrię;
  sekwencja 1 → 5 → 6 przywraca przyjmowanie komend.
- Interfejs zachowuje się jak sterowanie pozycyjne. `t_ff`, `kp`, `kd`,
  `v_des` i `mode` nie dały deklarowanej podatności; `kp=0` może spowodować
  odrzucenie całej ramki i wymagać restartu zasilania.
- Włączenie bez równoległego utrzymywania `p_des = q` spowodowało incydent:
  ruch **76,36°** przy nasyconym wysiłku. Reguła bezpiecznego załączania jest
  więc wymagana, ale repo nie zawiera osobnej, podpisanej paczki odbiorowej tej
  reguły.
- Panel implementuje pojedynczego właściciela CAN, okna stawów, limit narastania
  30°/s, odrzucanie NaN/inf, bramę engage oraz auto-disengage po utracie
  feedbacku lub połączenia operatora.
- Bridge implementuje kolejkę zadania, limity 12° na krok i 40° na rundę,
  raportowanie etapów oraz `disengage()` w `finally`.
- Kamera nadgarstkowa poprawiła powtarzalność kierunku planu. Nie ma jednak
  zapisanej kalibracji ekstrynsycznej ani niepewności transformacji.
- Repo zawiera rejestrator A1X i konwersję do LeRobot, lecz nie zawiera
  wynikowego datasetu ani jego wersji.

## Twierdzenia wycofane lub nadal nieudowodnione

- Raport jawnie wycofuje wcześniejsze twierdzenie, że `p_des = q` tworzy stan
  podatny z działającą telemetrią. Kontrola A/B/C wykazała, że obserwowana
  podatność była właściwością mechaniczną stawów, nie wynikiem sterowania.
- E-stop nie został przetestowany.
- Surowe pliki `.raw` i `.log` wymienione w raporcie nie są śledzone w repo.
- Nie zmierzono zasięgu ani udźwigu wymaganych do kompletnej rewizji
  embodimentu.
- Nie ma ważnych rekordów kalibracji, pomiaru niepewności, paczki P0,
  podpisanego indeksu mediów ani fizycznego potwierdzenia limitów.
- Nie ma wag polityki, niezależnego `declaredSpecDigest`, wersji datasetu,
  hiperparametrów treningu ani zestawów ewaluacyjnych.
- Nie wykonano pełnego shadow runu ani rollout'u wg bram P0–P3.

## Mapowanie na handoff

| Punkt | Stan po audycie | Dowód / brak |
| --- | --- | --- |
| A1 zasięg i payload | brak | wartości nadal niezmierzone |
| A2 kalibracje | brak | są narzędzia i URDF, brak ważnego rekordu z niepewnością |
| A3 warstwa bezpieczeństwa | częściowo | ograniczenia programowe istnieją; E-stop i kategoria bezpieczeństwa niezweryfikowane |
| B1 przestrzeń obserwacji/akcji | częściowo | kod opisuje 6 stawów + chwytak i radiany, brak wersjonowanego kontraktu polityki |
| B2/B3 digest i artefakty | brak | brak wag, URI i skrótów polityki |
| B4 wygaśnięcie dzierżawy | brak | źródłowy bridge używa pollingu/API key, nie mandatu z dzierżawą |
| C1–C4 polityka | brak odbioru | zero-shot bez akcji chwytaka; brak wytrenowanej polityki i shadow evidence |
| D1–D3 ewaluacja | brak | brak wersjonowanych suite'ów, wyników i progów |
| E1/E2 epizody i interwencje | częściowo | kolejka i etapy istnieją, ale nie w aktualnym podpisanym kontrakcie ERP |
| E3 agent edge | niezgodny | statyczny API key zamiast sesji Ed25519 i rosnącej sekwencji |
| E4 okna detekcji | brak dowodu | tracking istnieje w kodzie, brak paczki telemetrycznej zgodnej z ERP |
| F2 masa nominalna | brak | brak danych SKU/frakcji |
| F3 tryby awarii | częściowo | opisano pusty chwyt, płaski plan, timeout i błędy transportu |
| F4 reprodukowalność | brak | brak runRef treningu, wersji datasetu i artefaktów |

## Decyzja integracyjna

Nie kopiujemy źródłowego modułu `robotics` do aktywnego ERP. Dublowałby
istniejące `fleet`, `edge`, `episodes` i `deployment`, a jego endpoint `abort`
sam zaznacza rekord i wprost nie zatrzymuje poruszającego się ramienia.

Źródłowego panelu nie wolno również wystawić poza odseparowaną sieć. Nie ma
uwierzytelniania WebSocket: rolę wyznacza wyłącznie adres IP, a każdy klient
spoza `agent_net` otrzymuje rolę operatora zdolną do `engage`, `goal`, `jog`,
`grip` i `enable`. Produkcyjny port wymaga wzajemnego uwierzytelnienia,
allowlisty urządzeń oraz lokalnego uprawnienia operatora; ograniczenia ruchu
nie kompensują braku kontroli dostępu.

Do dalszej implementacji nadają się jako materiał wejściowy:

1. transport panelu i jego zasada pojedynczego właściciela CAN;
2. ograniczenia planu z `bridge/om_bridge/safety.py`;
3. składanie obserwacji G0.5 i obsługa kamer;
4. detekcja pustego chwytu po pozycji i wysiłku chwytaka;
5. rejestrator oraz konwersja LeRobot.

Port produkcyjny musi zastąpić API key podpisaną sesją edge, emitować obecne
epizody i interwencje, respektować `leaseExpiryBehavior`, zapisywać paczkę
dowodową i pozostawić natychmiastowe zatrzymanie lokalnej warstwie
deterministycznej.

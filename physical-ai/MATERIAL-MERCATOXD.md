# Materiał `mercatoXD` - co domyka nasze bramy, a co zostaje otwarte

Źródło: commit `fd5fe08f24ae35fe37c8053086327fdc1a14363a`, utworzony
**2026-09-19 21:37:49 +02:00**, autor Greg. Pełny dozwolony snapshot oraz
pochodzenie są w
[`evidence/hackathon-2026-09-18-19/mercatoXD`](evidence/hackathon-2026-09-18-19/mercatoXD/README.md).

## Czym ten dokument jest, a czym nie jest

To jest **inwentaryzacja materiału po naszej stronie**: co z prac
hackathonowych daje się użyć jako dowód dla bram P0-P3 i jako materiał
wejściowy do portu produkcyjnego.

To **nie jest ocena pracy zespołu physical**, i nie wolno go tak czytać ani
cytować. Rozstrzyga o tym chronologia:

| Data (Europe/Warsaw) | Zdarzenie |
| --- | --- |
| 2026-08-23 | pomiary A1X/A1XY na CAN-FD (incydent 76,36°, mapa kodów funkcyjnych) |
| 2026-09-18 → 09-19 | sesje hackathonowe: panel, tracking, G0.5 na DGX, próby chwytu |
| **2026-09-19 12:48** | **powstaje nasz `HANDOFF-PHYSICAL.md`** |
| 2026-09-19 21:37 | jedyny zbiorczy commit źródła `fd5fe08` |

Większość materiału powstała **przed** naszym handoffem, a część miesiąc
wcześniej. Autor nie pracował na naszej wtyczce: dostał opis dziedziny i
postawił własny system, z własnym modułem `robotics` i własnym API. Braki
wyliczone niżej są więc **brakami w naszym zestawie dowodowym**, a nie
niewykonaną pracą po czyjejś stronie.

## Co zostało rzeczywiście wykazane na sprzęcie

- A1X przyjmuje pozycje przez CAN-FD; w kontrolowanej próbie ruch osiągnął
  około 98-102% zadanego kroku.
- Zmapowano kody funkcyjne 1-6. Kod 2 wyłącza moment, ale zamraża telemetrię;
  sekwencja 1 → 5 → 6 przywraca przyjmowanie komend.
- Interfejs zachowuje się jak sterowanie pozycyjne. `t_ff`, `kp`, `kd`,
  `v_des` i `mode` nie dały deklarowanej podatności; `kp=0` może spowodować
  odrzucenie całej ramki i wymagać restartu zasilania.
- **Incydent załączenia:** włączenie bez równoległego utrzymywania
  `p_des = q` dało ruch **76,36°** przy nasyconym wysiłku. To najcenniejszy
  pojedynczy fakt z całego materiału - reguła bezpiecznego załączania jest
  wymagana, ale nie ma jeszcze osobnej, podpisanej paczki odbiorowej tej
  reguły ani testu akceptacyjnego po naszej stronie.
- Panel implementuje pojedynczego właściciela CAN, okna stawów, limit
  narastania 30°/s, odrzucanie NaN/inf, bramę engage oraz auto-disengage po
  utracie feedbacku lub połączenia operatora.
- Bridge implementuje kolejkę zadania, limity 12° na krok i 40° na rundę,
  raportowanie etapów oraz `disengage()` w `finally`.
- Kamera nadgarstkowa poprawiła powtarzalność kierunku planu. Nie ma jednak
  zapisanej kalibracji ekstrynsycznej ani niepewności transformacji.
- Repo zawiera rejestrator A1X i konwersję do LeRobot, lecz nie zawiera
  wynikowego datasetu ani jego wersji.

Bridge przeszedł **56/56 testów** bez sprzętu przy 84% pokrycia instrukcji.
Testy używają atrap, więc potwierdzają zachowanie programu, nie maszyny.

## Twierdzenia wycofane przez samo źródło lub nadal nieudowodnione

- Raport jawnie wycofuje wcześniejsze twierdzenie, że `p_des = q` tworzy stan
  podatny z działającą telemetrią. Kontrola A/B/C wykazała, że obserwowana
  podatność była właściwością mechaniczną stawów, nie wynikiem sterowania.
  Wycofanie własnego wyniku po kontroli jest sygnałem rzetelności źródła,
  nie jego słabości.
- **Nie ma zaliczonego autonomicznego chwytu.** G0.5 w żadnej obserwowanej
  próbie nie wyemitował akcji chwytaka; chwyt jest zamykany skryptem. Tego
  wyniku nie wolno raportować jako zaliczonego picku.
- E-stop nie został przetestowany.
- Surowe pliki `.raw` i `.log` wymienione w raporcie nie są śledzone w źródle.
- Nie zmierzono zasięgu ani udźwigu wymaganych do kompletnej rewizji
  embodimentu.
- Brak ważnych rekordów kalibracji, pomiaru niepewności, paczki P0,
  podpisanego indeksu mediów ani fizycznego potwierdzenia limitów.
- Brak wag polityki, niezależnego `declaredSpecDigest`, wersji datasetu,
  hiperparametrów treningu i zestawów ewaluacyjnych.
- Nie wykonano pełnego shadow runu ani rolloutu wg bram P0-P3.

## Stan naszego zestawu dowodowego po uwzględnieniu materiału

Kolumna mówi, czy ten konkretny materiał domyka naszą bramę. „Brak" znaczy
„nadal potrzebujemy tego dowodu", a nie „ktoś tego nie zrobił".

| Nasza brama | Czy materiał ją domyka | Czego brakuje |
| --- | --- | --- |
| A1 zasięg i payload | nie | wartości niezmierzone |
| A2 kalibracje | nie | są narzędzia i URDF, brak ważnego rekordu z niepewnością |
| A3 warstwa bezpieczeństwa | częściowo | ograniczenia programowe udokumentowane; E-stop i kategoria bezpieczeństwa niezweryfikowane |
| B1 przestrzeń obserwacji/akcji | częściowo | kod opisuje 6 stawów + chwytak i radiany; brak wersjonowanego kontraktu polityki |
| B2/B3 digest i artefakty | nie | brak wag, URI i skrótów polityki |
| B4 wygaśnięcie dzierżawy | nie | pojęcie dzierżawy nie występuje w źródle |
| C1-C4 polityka | nie | zero-shot bez akcji chwytaka; brak wytrenowanej polityki i shadow evidence |
| D1-D3 ewaluacja | nie | brak wersjonowanych suite'ów, wyników i progów |
| E1/E2 epizody i interwencje | częściowo | etapy i wyniki istnieją w innym kształcie; do przeniesienia na nasz podpisany kontrakt |
| E3 agent edge | nie | źródło używa statycznego klucza API do własnego API; nasza sesja Ed25519 wymaga portu |
| E4 okna detekcji | nie | tracking istnieje w kodzie, brak paczki telemetrycznej w naszym formacie |
| F2 masa nominalna | nie | brak danych SKU/frakcji |
| F3 tryby awarii | częściowo | opisano pusty chwyt, płaski plan, timeout i błędy transportu |
| F4 reprodukowalność | nie | brak runRef treningu, wersji datasetu i artefaktów |

## Zbieżności i rozbieżności projektowe

Ponieważ autor budował niezależnie, z opisu dziedziny, materiał jest
naturalnym eksperymentem: pokazuje, które z naszych abstrakcji są nieuchronne,
a które są nasze.

**Zbiegło się bez uzgodnienia** - epizod jako jednostka pracy z wynikiem,
raportowanie etapu osobno od zakończenia, limity planu jako osobna warstwa,
detekcja pustego chwytu po pozycji i wysiłku chwytaka, zwolnienie napędu
w `finally`.

**Rozjechało się całkowicie** - tożsamość agenta, model pracy (odpytywanie
o zadanie zamiast stanu pożądanego), dzierżawa, wersjonowanie polityki
i rewizja embodimentu.

Wniosek praktyczny: część zbieżna nie wymaga specyfikacji, bo wymyśli ją
każdy kompetentny implementator. Część rozbieżna nie jest oczywista dla
nikogo poza nami - i to ona, a nie całość, jest kandydatem na spisany
kontrakt z testem zgodności.

## Decyzja integracyjna

Nie kopiujemy źródłowego modułu `robotics` do aktywnego ERP. Dublowałby
istniejące `fleet`, `edge`, `episodes` i `deployment`, a jego endpoint `abort`
sam zaznacza rekord i wprost nie zatrzymuje poruszającego się ramienia.

Źródłowego panelu nie wolno wystawić poza odseparowaną sieć. Nie ma
uwierzytelniania WebSocket: rolę wyznacza wyłącznie adres IP, a każdy klient
spoza `agent_net` otrzymuje rolę operatora zdolną do `engage`, `goal`, `jog`,
`grip` i `enable`. Dla kodu hackathonowego na odciętej sieci jest to
dopuszczalne; to warunek brzegowy ponownego użycia, nie defekt dostarczonego
materiału. Produkcyjny port wymaga wzajemnego uwierzytelnienia, allowlisty
urządzeń oraz lokalnego uprawnienia operatora; ograniczenia ruchu nie
kompensują braku kontroli dostępu.

Do dalszej implementacji nadają się jako materiał wejściowy:

1. transport panelu i jego zasada pojedynczego właściciela CAN;
2. ograniczenia planu z `bridge/om_bridge/safety.py`;
3. składanie obserwacji G0.5 i obsługa kamer;
4. detekcja pustego chwytu po pozycji i wysiłku chwytaka;
5. rejestrator oraz konwersja LeRobot;
6. reguła bezpiecznego załączania wyprowadzona z incydentu 76,36°.

Port produkcyjny musi zastąpić klucz API podpisaną sesją edge, emitować
obecne epizody i interwencje, respektować `leaseExpiryBehavior`, zapisywać
paczkę dowodową i pozostawić natychmiastowe zatrzymanie lokalnej warstwie
deterministycznej.

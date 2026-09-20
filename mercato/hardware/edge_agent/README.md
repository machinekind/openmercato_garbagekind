# Agent referencyjny kanału brzegowego

Program uruchamiany **na komputerze przy robocie**. Łączy SO-101 z ERP: wpisuje
się kluczem Ed25519, bije uderzenia serca, pobiera stan pożądany, zgłasza stan
faktyczny i wysyła epizody. Jest punktem wyjścia dla agenta docelowego i
jednocześnie dowodem, że kontrakt centrali da się zrealizować niezależnym
klientem, a nie tylko własnymi testami.

Zależności: `cryptography` (podpisy Ed25519). Reszta to biblioteka standardowa.

## Kolejność

```bash
python3 mercato/hardware/edge_agent/cli.py init --base-url http://localhost:3000
python3 mercato/hardware/edge_agent/cli.py enroll --token <bilet z ERP>
python3 mercato/hardware/edge_agent/cli.py connect
python3 mercato/hardware/edge_agent/cli.py run --beats 100 --interval 30
python3 mercato/hardware/edge_agent/cli.py push --journal .runtime/so101-motion/journal.ndjson
```

Przełączniki wspólne (`--identity`, `--base-url`) stoją **przed** nazwą
polecenia: `cli.py --identity <plik> connect`.

`init` raz na maszynę, `enroll` raz na robota, `connect` po każdym restarcie.
Bilet wpisowy wystawia człowiek po stronie ERP (`edge.agents.issue_enrollment`);
jest jednorazowy i ma własny termin ważności.

## Podział plików

| Plik | Odpowiedzialność |
| --- | --- |
| `protocol.py` | kanoniczny JSON i przedrostki podpisów — musi zgadzać się co do bajtu z `edge/lib/crypto.ts` |
| `identity.py` | klucz Ed25519, odcisk z DER/SPKI, liczniki sekwencji, zapis 0600 |
| `client.py` | sześć endpointów: enroll, connect, heartbeat, telemetry, lease, report |
| `journal.py` | przekład dziennika ruchu SO-101 na epizody i interwencje |
| `cli.py` | wiersz poleceń |
| `conformance.mts` | porównanie z prawdziwymi modułami centrali pod Node |

## Rzeczy, które łatwo zrobić źle

- **Klucz prywatny nie opuszcza robota.** Plik tożsamości ma prawa 0600, a
  `status` wypisuje postać bez klucza. Centrala zna wyłącznie publiczny, więc
  wyciek jej bazy nie pozwala podszyć się pod maszynę.
- **Kanoniczny JSON to nie `json.dumps`.** Klucze sortowane na każdym poziomie,
  liczby zapisane po javascriptowemu: `1.0` jako `1`, `-0.0` jako `0`, `1e-07`
  jako `1e-7`. Rozjazd tutaj daje „podpis nieprawidłowy" bez wskazania przyczyny.
- **Przedrostki wiążą kontekst.** Podpis uderzenia serca nie przejdzie jako
  żądanie dzierżawy ani jako zgłoszenie stanu, i odwrotnie. Nie uogólniać ich
  do jednej funkcji z parametrem.
- **Dwa liczniki, nie jeden.** Uderzenia serca i telemetria dzielą licznik
  sesji; dzierżawy mają własny. Pomylenie ich kończy się odmową „numer kolejny
  nie jest większy od poprzedniego".
- **Restart zeruje liczniki**, bo `connect` otwiera nową sesję. Licznik jest
  per sesja, nie globalny.
- **Znacznik czasu z milisekundami.** `heartbeat` i `connect` centrala podpisuje
  po konwersji na `Date`, więc czas bez milisekund zostałby podpisany inaczej,
  niż zostanie odczytany.
- **`externalRef` jest kluczem idempotencji.** Ten sam epizod wysłany dwa razy
  daje jeden rekord — ponowne `push` po zerwaniu łączności jest bezpieczne.

## Przekład dziennika SO-101

`push` czyta dziennik z `mcp_server.py` i zamienia przejazdy na fakty:

| `status` przejazdu | `outcome` epizodu | interwencja |
| --- | --- | --- |
| `reached` | `success` | brak |
| `timeout` | `timeout` | brak |
| `halted_on_load` | `aborted` | `abort` / `unsafe_motion` |

Wpisy `enable` i `release` nie są przejazdami i nie stają się epizodami.

## Stan weryfikacji

Zweryfikowane: podpisy i kanoniczne postacie komunikatów zgadzają się z
**prawdziwymi modułami centrali** — `mercato/modules/edge/lib/crypto.ts` oraz
`mercato/modules/deployment/lib/protocol.ts` — ładowanymi pod Node 22 przez
`conformance.mts`. Test `tests/test_edge_agent_conformance.py` sprawdza
wszystkie siedem komunikatów, odcisk klucza, kanoniczny JSON z liczbami
granicznymi oraz to, że podpis uderzenia serca **nie** przechodzi jako
dzierżawa.

**Przebieg na żywo wykonany 20.09.2026** przeciwko uruchomionej instancji
(Open Mercato 0.8.0, robot `FR3-0001`). Zamknięte: `init` → `enroll` →
`connect` → **100 uderzeń serca, sekwencja 1→100 bez luki** → dzierżawa
(`desiredState: running`, `leaseExpiryBehavior: hold_position`) → podpisane
zgłoszenie stanu z werdyktem `converged`. Ślad jest w `edge_agent_sessions`,
`deployment_leases` i `deployment_state_reports`. To domyka **Z3** i **Z6**.

Przebieg ujawnił usterkę po stronie centrali, której nie miał czym złapać
żaden test jednostkowy: endpointy `/api/deployment/lease` i `/api/deployment/report`
budowały wejście komendy z `organizationId: ''`, więc **każde** żądanie agenta
kończyło się odmową 401 z błędu walidacji UUID. Wszystkie istniejące testy
wołały komendę wprost, z poprawnym zakresem, i sprawdzały komendę — nigdy
sklejenia route ↔ komenda. Poprawione wraz z testem regresji
(`deployment/__tests__/route.test.ts`).

Po drodze zadziałało też zamiatanie sesji: po pięciu minutach ciszy centrala
zamknęła sesję i odrzuciła kolejne uderzenie komunikatem „Sesja zamknięta
(timeout) — wymagane ponowne połączenie". Agent musiał wykonać `connect`,
a licznik wystartował od nowa. To jest zachowanie zamierzone, nie usterka:
licznik sekwencji jest per sesja, nie globalny.

Niezamknięte: **Z7** (telemetria epizodów) wymaga prawdziwego dziennika ruchu
z podłączonego ramienia. Syntetycznego nie wysyłamy — księga epizodów jest
podstawą bramy wdrożenia i nie wolno jej zasiać zmyślonymi liczbami.

# Fizyczny odbiór SO-101

Ten katalog domyka punkty z `physical-ai/EMBODIMENTS.md`, których nie wolno
uznać na podstawie dokumentacji producenta. Narzędzie gromadzi jeden raport
JSON, ale każdy krok pozostaje osobnym dowodem.

## Zasady bezpieczeństwa

- `scan` i `inspect` nie zapisują niczego do serw ani nie zmieniają momentu.
- `calibrate` wyłącza moment i wymaga ręcznego przeprowadzenia każdego stawu
  przez pełny zakres. Ramię musi być podparte, a przestrzeń robocza pusta.
- `torque-off` celowo zwalnia wszystkie stawy. Ramię musi być podparte.
- Narzędzie nigdy nie włącza momentu i nie wysyła pozycji zadanej.
- Przycisk zatrzymania aplikacji nie jest E-stopem. SO-101 bez zewnętrznej,
  deterministycznej warstwy bezpieczeństwa nie może pracować w celi
  współdzielonej z ludźmi.

## Środowisko

```powershell
py -3.12 -m venv .venv-so101
.\.venv-so101\Scripts\python -m pip install -r mercato\hardware\so101\requirements-hardware.txt
$py = '.\.venv-so101\Scripts\python.exe'
```

Jeśli LeRobot jest już zainstalowany w innym środowisku, można użyć jego
interpretera. Raport domyślnie powstaje poza Git w
`.runtime/so101-validation/evidence.json`.

## Procedura odbioru

1. Wykrycie portu i bezruchowy odczyt magistrali:

   ```powershell
   & $py mercato\hardware\so101\validate.py scan
   & $py mercato\hardware\so101\validate.py inspect --port COM5
   ```

   `inspect` wymaga dokładnie sześciu STS3215 o identyfikatorach 1–6. Zachowuje
   zastany stan `Torque_Enable`.

2. Prawdziwa kalibracja LeRobot:

   ```powershell
   & $py mercato\hardware\so101\validate.py calibrate --port COM5 `
     --robot-id mercato-so101-01 --valid-days 30 --uncertainty-deg 0.5 `
     --confirm CALIBRATE-SO101
   ```

   Wynik jest odczytywany z EEPROM, zapisywany przez LeRobot do pliku i
   haszowany. Operator musi jawnie podać okres ważności oraz zmierzoną lub
   uzasadnioną niepewność offsetu w stopniach — wartości w przykładzie nie są
   domyślne. Ważność jest również zdarzeniowa: wymiana serwa, ponowny montaż
   orczyka, kolizja albo zmiana ID/`drive_mode` unieważnia dowód przed datą.

3. Zasięg i udźwig mierzy się niezależnymi przyrządami. Nie wpisujemy wartości
   katalogowej. Przykład zapisu wykonanego pomiaru:

   ```powershell
   & $py mercato\hardware\so101\validate.py measure `
     --reach-mm 000 --payload-kg 0.000 `
     --reach-uncertainty-mm 0 --payload-uncertainty-kg 0 `
     --instrument 'miara S/N ...; waga S/N ...' --operator '...' `
     --method 'opis ustawienia, pozy i kryterium utrzymania 30 s' `
     --confirm VALUES-MEASURED
   ```

   Zera w przykładzie są celowo niedozwolone — trzeba podać wynik pomiaru.

4. Pomiar zasilania wykonuje się na biegu jałowym i pod kontrolowanym
   obciążeniem. Zakres oczekiwany musi pochodzić z rzeczywistego zasilacza
   zestawu, nie z założenia, że każdy SO-101 pracuje na tym samym napięciu:

   ```powershell
   & $py mercato\hardware\so101\validate.py power `
     --expected-min-v 0 --expected-max-v 0 `
     --measured-idle-v 0 --measured-loaded-v 0 `
     --instrument 'multimetr S/N ...' --operator '...' `
     --method 'punkty pomiarowe i obciążenie' --evidence-uri 'sha256:...' `
     --confirm POWER-MEASURED
   ```

5. Test zatrzymania przez wyłączenie momentu:

   ```powershell
   & $py mercato\hardware\so101\validate.py torque-off --port COM5 `
     --confirm ARM-SUPPORTED-DISABLE-TORQUE
   ```

   Test przechodzi tylko wtedy, gdy odczyt `Torque_Enable` wynosi `0` na
   wszystkich sześciu serwach. Ramię pozostaje z wyłączonym momentem.

6. Osobno wykonuje się fizyczny test E-stopu oraz lokalnych limitów. Próba
   musi objąć spoczynek, ruch i chwyt oraz limity pozycji, prędkości i timeoutu:

   ```powershell
   & $py mercato\hardware\so101\validate.py safety `
     --mechanism hardware_estop --bypassable false --stop-time-ms 0 `
     --estop-scenarios idle,motion,grasp `
     --limit-tests position,speed,command_timeout `
     --implemented-in 'nazwa sterownika bezpieczeństwa' `
     --reset-procedure 'opis resetu' --operator '...' `
     --method 'opis pomiaru' --evidence-uri 'sha256:...' `
     --confirm PHYSICAL-SAFETY-TESTED
   ```

   Zerowy czas w przykładzie jest niedozwolony. Wartość `bypassable` musi
   opisywać rzeczywiste okablowanie i konfigurację; `false` w przykładzie nie
   jest założeniem o stanowisku. `torque-off` nie zastępuje E-stopu i sam nie
   zalicza tego kroku.

7. Jeśli istnieje polityka, haszujemy prawdziwe artefakty:

   ```powershell
   & $py mercato\hardware\so101\validate.py artifacts `
     --policy-dir D:\policy\so101 `
     --artifact-base-uri s3://physical-ai/policies/<runRef> `
     --task-key sort-plastic --training-run-ref <runRef> `
     --framework 'LeRobot 0.6.1' --dataset-version <wersja> `
     --declared-spec-digest <sha256-kontraktu-embodimentu>
   ```

   `declaredSpecDigest` musi pochodzić z metadanych rozpoczętego treningu,
   a nie być wyliczony ponownie z bieżącej bazy podczas wgrywania. Raport
   zapisuje role `weights`, `config`, `metadata`, `preprocessor` i
   `normalizer`, docelowe URI oraz SHA-256 każdego istniejącego pliku.

8. Komplet dowodów trzeba najpierw zamknąć w niezmiennym pliku. Polecenie
   samo oblicza SHA-256; operator nie wpisuje skrótu ręcznie:

   ```powershell
   & $py mercato\hardware\so101\validate.py seal `
     --output .runtime\so101-validation\evidence.sealed.json `
     --confirm SEAL-PHYSICAL-EVIDENCE
   ```

9. Dopiero zamknięty raport może utworzyć kolejną, niezmienną rewizję opisu:

   ```powershell
   & $py mercato\hardware\so101\validate.py finalize `
     --spec mercato\embodiments\so101_follower.json `
     --output mercato\embodiments\so101_follower.r2.json `
     --sealed-report .runtime\so101-validation\evidence.sealed.json `
     --confirm CREATE-HARDWARE-REVISION
   ```

`finalize` odmawia działania, jeśli choć jeden z dowodów: magistrala,
kalibracja, zasilanie, zasięg, udźwig, torque-off, E-stop lub limity lokalne
nie ma statusu `passed`. Nie nadpisuje istniejącego pliku i zwiększa numer
rewizji, bo fizycznie zweryfikowany kontrakt nie jest tą samą rewizją co opis
oparty wyłącznie na dokumentacji. Rewizja zawiera obliczony przez narzędzie
skrót zamkniętego raportu oraz `runRef`; raport z innego przebiegu jest
odrzucany.

## Demonstracja ruchu przez MCP

Ten tryb jest **osobny od odbioru** i nie produkuje dowodów P0. `validate.py`
nigdy nie włącza momentu; robi to wyłącznie `arm_control.py` wołane przez
serwer MCP `mercato/hardware/so101/mcp_server.py`.

```bash
SO101_PORT=/dev/ttyACM0 python3 mercato/hardware/so101/mcp_server.py
```

Konfiguracja dla klienta jest w `.mcp.json` w katalogu głównym repozytorium.

Narzędzia:

| Narzędzie | Skutek | Wymaga `confirm=true` |
| --- | --- | --- |
| `so101_status` | odczyt pozycji, momentu, napięcia, temperatury, obciążenia | nie |
| `so101_enable` | załącza moment przy `p_des = q` utrzymywanym 500 ms | tak |
| `so101_random_pose` | przejazd do pozy losowej; domyślnie `shoulder_pan` i `shoulder_lift` o ≤ 30° | tak |
| `so101_return_home` | powrót do pozy zastanej z chwili załączenia, moment zostaje | tak |
| `so101_release` | powrót do pozy zastanej, potem zwolnienie momentu | tak |

Ograniczenia wpisane w kod (`arm_control.py`):

- okno pozycji = limity z EEPROM zawężone o `SOFT_LIMIT_MARGIN_TICKS` (120);
- przyrost na jeden ruch ≤ 350 ticków (~31°), chwytak ≤ 150;
- `Goal_Velocity` 300 i `Acceleration` 10 dla każdego stawu;
- brama przed ruchem: napięcie 10,0–13,0 V, temperatura ≤ 50 °C,
  `|Present_Load|` ≤ 900; niepełny odczyt nie jest traktowany jako zdrowy;
- przekroczenie obciążenia w trakcie przejazdu zatrzymuje ramię na bieżącej
  pozycji i zwraca status `halted_on_load`;
- ruch bez wcześniejszego załączenia momentu jest odrzucany;
- `so101_enable` zapamiętuje pozę zastaną, a `so101_release` domyślnie do niej
  wraca przed zwolnieniem momentu, żeby ramię nie opadało z podniesionej pozy
  (`return_home=false` zwalnia od razu w bieżącej pozie).

Dziennik operacji powstaje poza Git w
`.runtime/so101-motion/journal.ndjson` (ścieżkę zmienia `SO101_MOTION_JOURNAL`).

### Czego ten tryb nie daje

`so101_release` **nie jest E-stopem**: idzie tą samą magistralą i tym samym
procesem, który może zawisnąć. Zamknięcie serwera MCP nie zmienia stanu
momentu — ramię zostaje tak, jak stało. Deterministyczną warstwą zatrzymania
jest wyłącznie zewnętrzny przerywacz zasilania napędów, którego ten zestaw nie
ma. Dopóki go nie ma, warunek Z5 z `GREG_HANDOFF.md` pozostaje niespełniony i
poza demonstracją nie wolno na tym sprzęcie uruchamiać polityki.

Przed każdym uruchomieniem: przestrzeń robocza pusta, ramię podparte,
wyłącznik zasilacza w zasięgu ręki.

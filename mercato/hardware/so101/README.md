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
     --robot-id mercato-so101-01 --confirm CALIBRATE-SO101
   ```

   Wynik jest odczytywany z EEPROM, zapisywany przez LeRobot do pliku i
   haszowany. Ważność jest zdarzeniowa: wymiana serwa, ponowny montaż orczyka,
   kolizja albo zmiana ID/`drive_mode` unieważnia dowód.

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
     --mechanism hardware_estop --stop-time-ms 0 `
     --estop-scenarios idle,motion,grasp `
     --limit-tests position,speed,command_timeout `
     --implemented-in 'nazwa sterownika bezpieczeństwa' `
     --reset-procedure 'opis resetu' --operator '...' `
     --method 'opis pomiaru' --evidence-uri 'sha256:...' `
     --confirm PHYSICAL-SAFETY-TESTED
   ```

   Zerowy czas w przykładzie jest niedozwolony. `torque-off` nie zastępuje
   E-stopu i sam nie zalicza tego kroku.

7. Jeśli istnieje polityka, haszujemy prawdziwe artefakty:

   ```powershell
   & $py mercato\hardware\so101\validate.py artifacts --policy-dir D:\policy\so101
   ```

8. Dopiero komplet dowodów może utworzyć kolejną, niezmienną rewizję opisu:

   ```powershell
   & $py mercato\hardware\so101\validate.py finalize `
     --spec mercato\embodiments\so101_follower.json `
     --output mercato\embodiments\so101_follower.r2.json `
     --evidence-uri 'sha256:<skrót zatwierdzonego raportu>' `
     --confirm CREATE-HARDWARE-REVISION
   ```

`finalize` odmawia działania, jeśli choć jeden z dowodów: magistrala,
kalibracja, zasilanie, zasięg, udźwig, torque-off, E-stop lub limity lokalne
nie ma statusu `passed`. Nie nadpisuje istniejącego pliku i zwiększa numer
rewizji, bo fizycznie zweryfikowany kontrakt nie jest tą samą rewizją co opis
oparty wyłącznie na dokumentacji.

# Backlog walidacji fizycznej po hackathonie 18–19.09.2026

Ten dokument rozdziela fakty potwierdzone w kodzie od rzeczy, które wymagają
realnego robota. Punktem odniesienia jest import dowodów z `mercatoXD` w
`physical-ai/evidence/hackathon-2026-09-18-19/mercatoXD`.

Dla SO-101 procedurę i generator raportu zawiera
`mercato/hardware/so101/README.md`. Narzędzie nie włącza momentu ani nie wysyła
pozycji zadanej; kroki ruchowe pozostają jawnie wykonywanymi próbami zespołu.

## Stan wejściowy z hackathonu

- A1X komunikował się po CAN, wykonywał ruchy stawów i chwytaka; zachowano
  skrypty diagnostyczne, presetowe okna ruchu i opis protokołu.
- E-stop A1X nie został fizycznie sprawdzony w opisanej sesji.
- Przy załączeniu A1X bez równoczesnego strumieniowania `p_des = q`
  zaobserwowano ruch 76,36° przy pełnym momencie. To jest incydent wejściowy,
  nie zaliczony test.
- G0.5 uruchomił inferencję, ale w obserwowanych próbach nie emitował kanału
  chwytaka i nie osiągnął autonomicznego chwytu.
- SO-101 miał komunikację i odczyt enkoderów, lecz szyna napędów miała około
  4,8 V; nie uzyskano ruchu ani realnego podniesienia odpadu. Wyników z mocka
  nie wolno przedstawiać jako walidacji sprzętu.
- Nie ma surowych plików logów z tych prób w repozytorium źródłowym. Import
  zachowuje dokumentację i kod bez fabrykowania brakujących zapisów.

## Format paczki dowodowej

Każdy przebieg ma stabilny `runRef` i katalog roboczy poza repozytorium:

```text
<data>/<robot>/<runRef>/
  run.json
  hardware.json
  calibration.json
  safety.json
  telemetry.ndjson
  interventions.ndjson
  media-index.json
  checksums.sha256
```

Do Git trafia tylko zanonimizowany indeks, skróty SHA-256 i podsumowanie.
Nagrania oraz ciężkie logi trafiają do magazynu obiektów DGX/edge. Każda
pozycja w `media-index.json` podaje URI, skrót, czas UTC, kamerę, retencję i
potwierdzenie anonimizacji. Zegary robota, kamer i DGX muszą być zsynchronizowane.

## P0 — bezpieczeństwo przed ruchem autonomicznym

- [ ] **A1X/SO-101: bezpieczne załączenie.** Udowodnić, że przed momentem
  podania momentu sterownik przez co najmniej 500 ms nadaje bieżące `q` jako
  `p_des`. Zapisać `q`, `p_des`, moment, stan enable i czas w jednej osi.
- [ ] **E-stop.** Sprawdzić osobno podczas spoczynku, ruchu i chwytu. Zmierzyć
  czas od sygnału do ustania poleceń i do zatrzymania mechanicznego. Zarejestrować
  sposób resetu; sam przycisk w UI nie jest dowodem.
- [ ] **Limity deterministyczne.** Wywołać kontrolowane naruszenie limitu
  pozycji, prędkości i timeoutu sterowania. Każdy przypadek ma zakończyć się
  odmową lub lokalnym zatrzymaniem niezależnym od ERP/DGX.
- [ ] **Człowiek w strefie.** Potwierdzić lokalny sygnał immediate-priority,
  reakcję robota i równoległą interwencję ERP z
  `reasonCategory: person_in_safety_zone`.

Warunek odbioru P0: komplet logów dla wszystkich prób, brak niekontrolowanego
ruchu i podpis osoby prowadzącej ocenę ryzyka. Bez P0 nie uruchamiamy polityki.

## P1 — kontrakt sprzętu i kalibracje

- [ ] Zmierzyć zasięg roboczy oraz payload A1X w konfiguracji używanej na
  stanowisku; uzupełnić rewizję embodimentu zamiast wartości `unknown`.
- [ ] Dla SO-101 potwierdzić napięcie znamionowe zestawu, zasilanie pod
  obciążeniem, limity wszystkich sześciu serw i znak każdego stawu.
- [ ] Wyznaczyć ekstrynsy kamer `exterior` i `wrist`, transformację podłogi
  digital twina oraz niepewność. Zapisać narzędzie, operatora, czas i termin
  ważności kalibracji.
- [ ] Zweryfikować semantykę chwytaka: jednostkę, kierunek, pozycję otwartą,
  zamknięcie bez detalu, zatrzymanie na detalu i próg wykrycia utrzymania.
- [ ] Wykonać próbę system-ID A1X: skok oraz sweep 0,5–5 Hz z poleceniem i
  pomiarem w tej samej osi czasu.

Warunek odbioru P1: `mercato fleet embodiment` nie zgłasza niekompletności,
a każda wymagana kalibracja ma ważny rekord i odcisk rewizji.

## P2 — dane, polityka i odzyskiwanie

- [ ] Zebrać prawdziwe demonstracje per `(taskKey, embodiment revision)`;
  żadnego mieszania A1X i SO-101 pod jednym kontraktem.
- [ ] Rejestrować negatywne epizody: pusty chwyt, wypadnięcie detalu,
  zasłonięta kamera, obiekt poza zasięgiem, utrata tracku i zakleszczenie.
- [ ] Każdy trening ma `runRef`, commit, wersję zbioru, hiperparametry,
  `declaredSpecDigest` zapisany przy starcie oraz skróty wszystkich artefaktów.
- [ ] Zweryfikować lokalnie `leaseExpiryBehavior` wybrany przez politykę:
  `hold_position`, `complete_grasp_then_hold` albo `return_home`.
- [ ] Detektor rejestruje zamknięty słownik klas. Okna podają jawnie
  `countingMode: tracks` albo `detections`; tracków nie wolno nazywać osobami.

Warunek odbioru P2: polityka przechodzi zgodność embodimentu i daje się
odtworzyć z wersji zbioru oraz kompletu artefaktów.

## P3 — ewaluacja i próba cieniowa

- [ ] Zdefiniować zestawy `nominal`, `edge_case`, `recovery` i `safety` jako
  wersjonowane artefakty z URI oraz SHA-256.
- [ ] Każdy przebieg wiąże dokładną wersję polityki, rewizję embodimentu,
  zestaw, wynik `pass|fail|error`, liczbę przypadków i URI dowodu.
- [ ] Uzgodnić progi bram dla konkretnego zadania; błąd wykonania zestawu
  traktować jak `fail`, nie jak brak wyniku.
- [ ] Uruchomić tryb cieniowy bez wysyłania akcji do napędów. Porównać akcje
  polityki z teleoperatorem i zarejestrować naruszenia limitów.
- [ ] Dopiero po P0–P3 wykonać stopniowy rollout w najniższej klasie ryzyka,
  z dostępnym operatorem i działającą telemetrią ERP.

## Dane wymagane od właściciela procesu

- [ ] `nominalPieceGrams` dla każdego SKU/frakcji używanej w zleceniach.
- [ ] Definicja sukcesu i trybów awarii dla każdego `taskKey`.
- [ ] Właściciel magazynu wideo i proces potwierdzania fizycznego usunięcia
  klipów po retencji (`vision.clips.confirm_deletion`).

Żadnego z powyższych pól nie uzupełniamy wartością „rozsądną domyślnie”. Brak
pomiaru pozostaje brakiem i blokuje odpowiednią bramę.

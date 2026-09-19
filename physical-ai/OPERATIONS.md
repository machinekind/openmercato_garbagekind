# Zadania cykliczne — różnica między zgodnością a notatką o zgodności

Punkt pierwszy z listy „commercial grade". Wybrany na pierwszy, bo jako jedyny
zmieniał zdanie z nieprawdziwego na prawdziwe.

## Co było nie tak

`vision.clips.purge` realizował ustawowy termin z art. 22² § 3 Kodeksu pracy —
zniszczenie nagrań po trzech miesiącach — **jako komendę wiersza poleceń,
której nic nie uruchamiało**. To samo z `edge.sessions.sweep`, od którego
zależał dowód fazy 0 („robot znika z pulpitu w zdefiniowanym czasie").

Dwa najmocniejsze twierdzenia projektu były zaimplementowane jako rzeczy,
o których trzeba pamiętać.

## Rzecz, która wyszła przy implementacji i była gorsza

Automatyzacja samego `purge` **nie dałaby zgodności**. Kolumna nazywała się
`purged_at`, komenda nazywała się „purge", a platforma nigdy nie kasuje
plików — bajty leżą w magazynie obiektów, do którego ERP nie ma dostępu
i mieć nie powinien.

Zautomatyzowanie oznaczania dałoby więc **zautomatyzowaną księgowość zamiast
zgodności**, a ekran pokazywałby zero zaległości przy nagraniach, które wciąż
leżą na dysku. Nikt by tego nie zauważył, bo kolumna nazywałaby się „purged".

Rozdzielone na dwa pola:

| Pole | Znaczy |
| --- | --- |
| `marked_for_deletion_at` | termin minął, materiał oznaczony |
| `deletion_confirmed_at` | **bajty naprawdę skasowane**, potwierdzone przez tego, kto je trzymał |

Właściwa liczba zgodności to **oznaczone i nadal istniejące**. Ona jest teraz
w panelu (`clipsMarkedNotDeleted`), w `vision status` i w ostrzeżeniu workera.

Ograniczenie w bazie odbija potwierdzenie bez oznaczenia: znaczyłoby, że
materiał skasowano poza procesem — może przed terminem, może mimo wstrzymania
dowodowego.

## Co powstało

| Moduł | Kolejka | Częstotliwość | Co robi |
| --- | --- | --- | --- |
| `vision` | `vision-clips-purge` | 24 h | oznacza materiał po terminie we wszystkich tenantach |
| `edge` | `edge-sessions-sweep` | 5 min | zamyka sesje agentów po progu ciszy |

Plus komenda `vision.clips.confirm_deletion` i `mercato vision confirm`,
którą woła proces kasujący bajty.

### Decyzje warte wypisania

**Przebieg dobowy przy terminie trzymiesięcznym** znaczy do 24 godzin luzu
ponad termin. Uznaję to za dopuszczalne i **zapisuję wprost**, zamiast udawać
zgodność co do sekundy. Zacieśnienie to zmiana jednej stałej.

**Zamiatanie co pięć minut, nie częściej** — bo to nie ono utrzymuje pulpit
w prawdzie. Żywotność liczy się z `last_seen_at` przy odczycie (decyzja
z fazy 0), więc brak workera nigdy nie dawał fałszywego „online". Worker
naprawia **księgę sesji**: bez niego sesja agenta odciętego od prądu zostaje
otwarta na zawsze i liczba sesji na dobę przestaje mierzyć migotanie łącza.

**Worker nie kwarantannuje utraconych maszyn**, mimo że ma do tego wszystko
pod ręką. Granica z fazy 0 zostaje: `edge` stwierdza ciszę, a wniosek „cisza
znaczy: nie wolno pracować" zapada w `fleet`. Zautomatyzowanie tego kroku
w workerze byłoby obejściem własnej decyzji projektowej przy pomocy zadania
cyklicznego.

**Awaria jednego tenanta nie zatrzymuje pozostałych** — to zadanie o terminie
ustawowym i ma dotknąć każdego, kogo dotyczy.

## Luka w platformie, na którą trzeba było dać obejście

`seedDefaults` jest wołane **wyłącznie przy inicjalizacji tenanta**. Moduł
doinstalowany do istniejącego wdrożenia — czyli dokładnie nasz przypadek —
nigdy nie zarejestrowałby swojego harmonogramu, i nikt by tego nie zauważył,
bo brak zadania nie generuje błędu, tylko ciszę.

Stąd `mercato vision install-schedules` i `mercato edge install-schedules`.
Idempotentne: identyfikator harmonogramu jest wyprowadzony ze stabilnego
klucza, a `register` nadpisuje.

## Dowód

```
 source_module |                 name                 | schedule_value |    target_queue     | is_enabled
---------------+--------------------------------------+----------------+---------------------+-----------
 vision        | Materiał wideo po terminie ustawowym | 24h            | vision-clips-purge  | t
 edge          | Zamiatanie sesji agentów po ciszy    | 5m             | edge-sessions-sweep | t
```

Oba widoczne w `mercato scheduler list` z wyliczonym następnym przebiegiem.

Wymuszenie przebiegu z wiersza poleceń (`scheduler run <id>`) kończy się
`Could not resolve 'queueService'` — kontener CLI nie ma usługi kolejki.
To ograniczenie środowiska, nie modułu: w działającej aplikacji workery są
uzbrojone i harmonogram odpala je sam.

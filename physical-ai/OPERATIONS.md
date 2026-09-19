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
| `fleet` | `fleet-calibration-expiry` | 1 h | ogłasza wygaśnięcie kalibracji (dołożone razem ze zdarzeniami modułowymi — patrz `EVENTS.md`) |

Komendy instalacyjne, które trzeba uruchomić po doinstalowaniu modułów do
działającego systemu (platforma zasiewa te zasoby wyłącznie przy inicjalizacji
tenanta):

```
mercato vision install-schedules
mercato edge  install-schedules
mercato fleet install-schedules
mercato fleet install-widgets
mercato edge  install-widgets
mercato safety install-widgets
```

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
 vision        | Materiał wideo po terminie ustawowym | 24h            | vision-clips-purge       | t
 edge          | Zamiatanie sesji agentów po ciszy    | 5m             | edge-sessions-sweep      | t
 fleet         | Wygasłe kalibracje                   | 1h             | fleet-calibration-expiry | t
```

Wszystkie widoczne w `mercato scheduler list` z wyliczonym następnym przebiegiem.

Zamiatanie sesji wykonało realny przebieg: `last_run_at = 2026-09-19 10:12:35`,
trzy sesje zamknięte po timeoucie. To jest różnica między „harmonogram
zarejestrowany" a „harmonogram działa".

Wymuszenie przebiegu z wiersza poleceń (`scheduler run <id>`) kończy się
`Could not resolve 'queueService'` — kontener CLI nie ma usługi kolejki.
To ograniczenie środowiska, nie modułu: w działającej aplikacji workery są
uzbrojone i harmonogram odpala je sam.

## Druga luka tej samej klasy: lista dozwolonych widgetów

Przy dokładaniu kafelków pulpitu (`fleet`, `edge`, `safety`) wyszła luka
bliźniacza do tej z harmonogramami, ale groźniejsza w skutkach.

`dashboard_role_widgets` trzyma **jawną listę dozwolonych widgetów na rolę**,
zapisywaną przy inicjalizacji tenanta. Kod platformy czyta ją tak:

```ts
baseSet = allowedByRole.size > 0 ? allowedByRole : new Set(allWidgetIds)
```

Lista niepusta znaczy „wolno wyłącznie to, co na niej jest". Moduł
doinstalowany później nie ma jak się na niej znaleźć — więc jego widget jest
zarejestrowany w `modules.generated.ts`, ładowany bez błędu i **niewidoczny
dla nikogo**, także w katalogu „Customize". Nie jest to awaria z komunikatem;
to kod, którego nikt nigdy nie uruchomi.

Diagnoza zajęła kilka fałszywych tropów, bo wszystkie oczywiste rzeczy się
zgadzały: wpis w rejestrze, typecheck, brak błędów importu, 26 zarejestrowanych
widgetów w pliku generowanym. W katalogu było 23 — różnica dokładnie nasza.

Obejście, tym samym wzorcem co `install-schedules`:

```
mercato fleet install-widgets
mercato edge install-widgets
mercato safety install-widgets
```

Komenda dopisuje identyfikator widgetu wyłącznie do list tych ról, które już
mają uprawnienie modułu (`fleet.view` albo `fleet.*`). Rola bez tego
uprawnienia i tak odbiłaby się o kontrolę cech przy renderowaniu, a dopisanie
jej widgetu byłoby cichą zmianą cudzej konfiguracji.

Osobna obserwacja, bez obejścia: trasa pulpitu woła kontrolę uprawnień
z zaszytym `isSuperAdmin: false`. Konto superadministratora **nie omija**
kontroli cech — jeśli jego rola nie ma jawnie `fleet.view`, widgetu nie
zobaczy, choć widzi wszystko inne. To zachowanie rdzenia, nie nasze.

**Reguła wyniesiona z obu przypadków:** wszystko, co platforma zasiewa przy
inicjalizacji tenanta — uprawnienia ról, harmonogramy, listy widgetów — jest
dla modułu doinstalowanego później niedostępne. Każdy taki zasób wymaga własnej
komendy instalacyjnej, a jej brak nie objawia się błędem, tylko ciszą.

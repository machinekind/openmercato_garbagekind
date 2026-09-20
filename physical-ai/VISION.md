# Wzrok maszynowy - trzeci świadek

Moduł `vision`. Wejście wideo, rozpoznawanie i raportowanie obiektów - z jedną
decyzją, która przesądza o kształcie wszystkiego innego.

## Platforma nie zobaczy ani jednej klatki

Trzy powody, każdy wystarczający osobno:

1. **Przepustowość.** Pięć cel po 30 klatek na sekundę to strumień, którego
   system ewidencyjny nie ma po co dotykać. Wnioskowanie należy do brzegu.
2. **Brak GPU i brak powodu, żeby go mieć.**
3. **Prawo.** Nagranie z hali to dane osobowe. [Art. 22² § 1 Kodeksu
   pracy](https://www.prawo.pl/biznes/monitoring-w-firmie-w-swietle-kodeksu-pracy-i-rodo,519475.html)
   dopuszcza monitoring wyłącznie w **zamkniętym katalogu celów** - bezpieczeństwo
   pracowników, ochrona mienia, **kontrola produkcji**, zachowanie tajemnicy -
   i nakazuje zniszczenie nagrań po **trzech miesiącach** (§ 3). ERP, który
   wciąga surowe wideo, dziedziczy obowiązek, do którego nie jest zbudowany.

Co w zamian: rejestr kamer z zadeklarowanym celem ustawowym, rejestr detektorów
z progiem ufności, **okna zliczeń** zamiast pojedynczych detekcji, i materiał
dowodowy wyłącznie przez odniesienie, z terminem usunięcia liczonym z kamery.

## Rdzeń: trzej świadkowie jednej pracy

Dotąd system miał dwóch: **deklarację robota** (czujnik chwytu) i **wagę**.
Dwóch świadków wystarcza, żeby stwierdzić, że coś się nie zgadza. Nie wystarcza,
żeby powiedzieć **co**.

Kamera nad pojemnikiem jest trzecim, niezależnym pomiarem:

| wizja | robot | masa | podejrzany | co to znaczy |
| ---: | ---: | ---: | --- | --- |
| 1000 | 1000 | 1000 | `none` | zgodne |
| 1000 | 1000 | 800 | `nominal_mass` | obiekty lżejsze niż nominał - **nie wina robota** |
| 800 | 1000 | 800 | `grip_to_bin` | materiał ginie między chwytem a pojemnikiem |
| 800 | 1000 | 1000 | `vision` | **to kamera nie widzi**, materiał jest |
| 1300 | 1000 | 1000 | `foreign_material` | obcy materiał albo podwójne liczenie |
| 1000 | 700 | 1000 | `under_reporting` | materiał jest, brakuje zgłoszeń |
| 600 | 1000 | 1500 | `inconclusive` | co najmniej dwie usterki, brak punktu odniesienia |

**Czwarty wiersz jest powodem, dla którego ta funkcja istnieje w tej postaci.**
Naiwna implementacja zawsze obwinia robota. Trzeci świadek musi umieć być
podejrzanym, inaczej dokłada pewności zamiast informacji.

Moduł wypisuje też, czego trójka **nie** rozstrzyga. Chwyt powietrza zaliczony
przez czujnik i sztuka upuszczona w drodze dają ten sam zestaw trzech liczb -
rozróżnia je dopiero kamera na nadgarstku. To jest w wyniku, nie w przypisie.

## Czego moduł odmawia

| Odmowa | Podstawa |
| --- | --- |
| detektor ze słownikiem klas emocjonalnych albo biometrycznych | [art. 5 ust. 1 lit. f i g rozporządzenia 2024/1689](https://ai-act-service-desk.ec.europa.eu/en/ai-act/faq/what-systems-are-prohibited-under-article-5-ai-act-eg-social-scoring-emotion-recognition) - zakaz wnioskowania emocji w miejscu pracy i kategoryzacji biometrycznej wnioskującej cechy wrażliwe, od 2 lutego 2025 r., sankcja do 35 mln euro albo 7% obrotu |
| kamera z celem spoza katalogu ustawowego | art. 22² § 1 KP - katalog jest **zamknięty**, nie ma pozycji „inne" |
| kamera z przechowywaniem ponad 90 dni | art. 22² § 3 KP |
| detektor z progiem ufności równym zeru | to nie są zliczenia obiektów, tylko zliczenia hipotez modelu |
| zliczenia klas spoza słownika detektora | na brzegu działa inny model, niż zapisano w rejestrze |
| termin usunięcia podany z wejścia | liczony z kamery - inaczej byłby pierwszym polem ustawionym na rok |

Odmowa znaczy **odrzucenie zapisu**, nie ostrzeżenie. Ostrzeżenie, które da się
kliknąć, jest ostrzeżeniem, które zostanie kliknięte.

Klasa `person` przechodzi, ale **wyłącznie jako obecność** - bez identyfikacji,
bez śledzenia, bez przypisania do pracownika. Ludzie nie wchodzą też do rachunku
składu frakcji: obecność człowieka w kadrze jest sygnałem bezpieczeństwa,
a nie zanieczyszczeniem materiału.

Braki formalne (brak poinformowania załogi na dwa tygodnie przed - § 7, brak
oznaczenia obszaru dzień przed - § 9) są **ostrzeżeniami**, nie odmowami:
celu spoza katalogu nie naprawi żadna zgoda, a brak poinformowania owszem -
byle przed uruchomieniem. Rozdział na `problems` i `warnings` jest treścią,
nie kosmetyką.

## Dwie rzeczy, które łatwo policzyć źle

**Ścieżki, nie detekcje.** Butelka widoczna w trzydziestu klatkach to jeden
obiekt, nie trzydzieści. Okno zliczeń niesie `countingMode`, a panel odmawia
sumowania okien mieszających tryby - suma byłaby bez znaczenia.

**Liczba klatek jest równie ważna jak zliczenia.** Okno policzone z dwunastu
klatek i okno policzone z tysiąca ośmiuset wyglądają identycznie w kolumnie
„liczba obiektów", a znaczą co innego.

## Skład frakcji

Prawdziwy powód, dla którego w sortowni stawia się kamerę nad pojemnikiem, to
nie liczenie sztuk, tylko zdanie: **„ta frakcja PET ma 4% PCW"**. Odbiorca
z takim wynikiem odeśle transport, a spór będzie o to, czy zanieczyszczenie
powstało u nas. `contamination()` liczy udział obcych klas; pusty pojemnik daje
`null`, a nie „zero procent" - zero procent to twierdzenie o materiale, a pusty
pojemnik do takiego twierdzenia nie uprawnia.

## Uruchomienie

```bash
yarn mercato vision prove                        # odmowy + cztery scenariusze + spięcie z partiami
yarn mercato vision triangulate --container BIN-A-…
yarn mercato vision status                       # kamery i zgodność formalna
yarn mercato vision purge                        # materiał po terminie
```

Ekran: `/backend/vision`, uprawnienie `vision.view`. **Nagrania są za osobnym
uprawnieniem** `vision.clips.view` - podgląd zliczeń i podgląd nagrania
pracownika to dwie różne rzeczy.

`purge` **nie kasuje plików**. Zwraca adresy do skasowania i oznacza wpisy;
bajty leżą w magazynie obiektów, do którego ta platforma nie ma dostępu -
inaczej ERP stałby się systemem zdolnym nieodwracalnie usunąć materiał dowodowy.

## Trzeci raz ta sama klasa błędu

Okno wizji wypadło poza okno partii, bo liczyłem je ze stałego przesunięcia
(otwarcie + minuta, dziesięć minut długości) zamiast z rzeczywistego czasu
trwania partii. Dowód pokazywał „brak trzeciego świadka" tam, gdzie właśnie go
dołożył.

To **trzecie** wystąpienie tego samego błędu w tym projekcie - po fazie 4
i po moście do ERP. Wniosek jest za każdym razem ten sam i zapisuję go tutaj,
skoro nie nauczyłem się go po dwóch: **okno czasowe wyprowadzać z danych,
nigdy z zegara ani ze stałej.**

## Czego ten moduł nie robi

- **Nie widział żadnej kamery.** Zliczenia w dowodzie są wytworzone; sprawdzane
  jest łączenie po celi i oknie czasowym, nie wzrok maszynowy.
- **Nie wnioskuje.** Detekcja dzieje się na brzegu; tu trafia policzony wynik.
- **Nie przechowuje wideo** i nie ma go przechowywać.
- **Nie rozróżnia chwytu powietrza od upuszczenia** - potrzebna kamera
  na nadgarstku, i jest to wypisane w każdym takim werdykcie.

# Rzut hali - gdzie co stoi, w jakim jest stanie i co z tego wyszło

Ekran `/backend/plant`. Pierwszy w tym projekcie, który pokazuje **przestrzeń**,
a nie listę.

## Rzecz, której system nie wiedział

Do tej pory nic w systemie nie wiedziało, **gdzie** cokolwiek fizycznie stoi.
Hierarchia obiekt → cela → robot mówiła o przynależności, nie o położeniu.
Doszła więc geometria: wymiary hali przy obiekcie, obrys i pozycja przy celi,
wszystko w metrach, początek w lewym górnym rogu, oś Y w dół (bo rysujemy
w SVG - przeliczanie znaku przy każdej transformacji dałoby jeden błąd znaku
na miesiąc).

## Zasada, która przesądziła o kształcie ekranu

**Cela bez kompletu współrzędnych nie jest rysowana.**

Kusiło, żeby rozstawić je automatycznie - siatką, po kolei, „gdzieś sensownie".
To dałoby obrazek, który wygląda jak plan hali i nim nie jest. A plan hali
czyta się po to, żeby wiedzieć, gdzie iść: zmyślona pozycja jest gorsza niż
jej brak, bo brak widać.

Cele nierozmieszczone trafiają więc na listę **obok** rysunku, z podaną liczbą
robotów i powodem. Tak samo roboty bez przypisanej celi: „stoją na hali,
rejestr nie wie gdzie".

To jest ta sama reguła, co `unknown` w opisie embodimentu SO-101 - niewiedza
ma być widoczna w danych, a nie schowana w wartości domyślnej.

Konsekwencje w kodzie:

- **Trzy z czterech współrzędnych to brak, nie „prawie".** Komenda
  `fleet.cells.layout` wymaga kompletu; zapis częściowy dałby rekordy, których
  nie da się ani narysować, ani uczciwie nazwać nierozmieszczonymi.
- **Zerowy wymiar to brak, nie cela o zerowej powierzchni** - sprawdzane
  w kodzie i ograniczeniem w bazie, bo przeszedłby dalej i dał dzielenie
  przez zero przy skalowaniu.
- **Pusta obwiednia daje `null`, nie zerowy prostokąt** - z tego samego powodu.

## Jedyne automatyczne rozstawienie, na które sobie pozwalam

Roboty wewnątrz celi. Wolno, bo nie udaje pomiaru: robot jest rysowany
**wewnątrz swojej celi**, a cela ma prawdziwe współrzędne. Twierdzimy „ten
robot stoi w tej celi", co jest prawdą - nie „stoi dokładnie tutaj", czego
nikt nie mierzył.

## Co niesie obraz

| Element | Znaczenie |
| --- | --- |
| obrys celi ciągły / przerywany | klasa ryzyka: ogrodzona, dzielona z ludźmi, przestrzeń publiczna |
| wypełnienie kropki | stan robota (w ruchu, gotowy, serwis, kwarantanna…) |
| **pierścień** wokół kropki | brak łączności agenta |
| wykrzyknik w kropce | kalibracja nieważna - robot nie ma prawa pracować |
| liczby w dolnej krawędzi celi | kilogramy z wagi, partie z niedoborem, podejrzenia wizji |

Rozdział wypełnienia od pierścienia jest celowy: robot „w ruchu", o którym
centrala nic nie wie od pół godziny, **wygląda inaczej** niż robot w ruchu,
który się odzywa. Jedno pole nie umiałoby tego powiedzieć.

Skala jest jedna dla obu osi. Osobne wypełniłyby kadr lepiej i zniekształciły
proporcje - a prostokątna cela ma wyglądać jak prostokątna cela, bo po tym się
ją rozpoznaje na miejscu.

## Cztery źródła, trzy opcjonalne

Ekran składa `fleet` (geometria i stan), `edge` (łączność), `work_orders`
(kilogramy) i `vision` (podejrzani). Składanie dzieje się **w przeglądarce**,
każda warstwa w osobnym `try` - ta sama zasada, co przy pulpicie floty
i z tego samego powodu: na świeżej instalacji z samym `fleet` rzut ma działać.
Brak modułu albo brak uprawnienia odejmuje warstwę informacji, a nie wywraca
rysunku, i jest **wypisany** w nagłówku („wynik: warstwa niedostępna").

Łączenie idzie po identyfikatorze celi, nie po nazwie - dlatego panele
`work_orders` i `vision` dostały `cellId` w odpowiedzi. Nazwy się powtarzają
i zmieniają.

## Uruchomienie

```bash
yarn mercato fleet layout    # nadaje obmiar demonstracyjny istniejącym celom
```

Ekran: `/backend/plant`, uprawnienie `fleet.view`.

W prawdziwym wdrożeniu współrzędne biorą się z obmiaru hali albo z rzutu
architektonicznego. **Nie ma dla nich sensownej wartości domyślnej** i komenda
nie udaje, że ma: cela bez wpisu w tabeli rozstawienia zostaje nierozmieszczona
i mówi o tym na ekranie.

## Czego ten rzut nie pokazuje

- **Pozycji robota wewnątrz celi** - nikt jej nie mierzył.
- **Pola widzenia kamer.** Kamera ma celę, ale nie ma współrzędnych ani
  azymutu; rysowanie stożka widzenia byłoby dokładnie tym zmyślaniem, którego
  reszta ekranu unika. Póki co kamera jest liczbą przy celi.
- **Nic w czasie rzeczywistym.** Odświeżanie co 15 sekund. To jest pulpit
  ewidencyjny, nie pulpit sterowania - i nie ma nim być.

# Most hala ↔ przedsiębiorstwo

Moduł `work_orders`. Pierwszy w tym repozytorium, który wymaga obu światów
naraz: rejestru floty i epizodów z jednej strony, katalogu i magazynu Open
Mercato z drugiej. To jest miejsce, w którym ERP przestaje być systemem obok
hali i staje się panelem, na którym halę widać.

## Rdzeń: dwie liczby, które nie są tą samą liczbą

Robot mówi: **„wykonałem 1000 udanych chwytów"**. To jest jego zdanie o sobie,
oparte na jego własnym czujniku chwytu.

Waga mówi: **„w pojemniku jest 24 kilogramy"**.

Przy masie nominalnej sztuki 30 g te dwie liczby powinny dać 30 kg. Dają 24.
Sześciu kilogramów nie ma, a w telemetrii robota **nie widać po nich śladu** -
bo z jego punktu widzenia te chwyty były udane.

To jest jedyne miejsce w całym projekcie, gdzie zdanie maszyny o własnej pracy
jest konfrontowane z czymś spoza maszyny.

## Trzy decyzje, każda przeciw wygodniejszej alternatywie

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Do magazynu idzie **masa z wagi**, nigdy deklaracja robota | zapas liczony z epizodów | robot gubiący co dziesiątą sztukę byłby niewidoczny w każdym zestawieniu; jego błąd stałby się stanem magazynowym |
| Rozjazd **nie wstrzymuje** przyjęcia | blokada materiału do wyjaśnienia | pojemnik stoi na wadze, materiał fizycznie istnieje; magazyn, który go nie przyjmuje, zapisuje nieprawdę, a operator i tak wysypie zawartość na hałdę. Flaga dotyczy **maszyny**, nie materiału |
| Most jest **jednokierunkowy**: epizody → masa | automatyczne zlecanie pracy z zamówień sprzedaży | ERP ma opóźnienia i tryby awarii systemu ewidencyjnego, nie sterowania ruchem; zamówienie, które samo porusza maszyną, jest sprzężeniem, przez które błąd w ERP zatrzymuje albo rozpędza halę |

Dodatkowo: masy są w **gramach jako liczbach całkowitych**. Bilans masy
w sortowni pokazał już raz, że suma stu wartości po 3803,73 zależy od kolejności
sumowania. Przeliczenie na kilogramy dzieje się na granicy - przy komendzie
magazynowej i na ekranie.

## Niesymetryczność werdyktów

`overclaim` (waga pokazała mniej) i `underclaim` (waga pokazała więcej) to nie
są dwa kierunki tego samego zjawiska:

- **overclaim** - robot policzył jako sukces materiał, którego nie przyniósł.
  Upuszczona sztuka, chwyt powietrza zaliczony przez czujnik, sztuka wypchnięta
  z pojemnika. Podnosi flagę na maszynę.
- **underclaim** - materiał w pojemniku nie pochodzi w całości z policzonych
  chwytów albo masa nominalna jest zawyżona. Sygnał o danych, nie o maszynie.
- **no_reference** - brak masy nominalnej. Werdyktu nie ma i **nie wolno go
  podstawić** średnią z innej frakcji: wyglądałby jak pomiar, a byłby
  zgadywaniem.

Rozjazd zbiorczy sumuje **gramy**, a nie uśrednia procenty - średnia z procentów
daje tę samą wagę partii dwutonowej i pięciokilogramowej.

## Dowód

```
DOWÓD MOSTU - waga rozstrzyga o zapasie, deklaracja robota o ocenie robota

   cela Cela A - gniazdo odkładcze, frakcja 20 01 01, waży superadmin@acme.com
   zlecenie ZR/…, cel 60,00 kg, masa nominalna sztuki 30 g

A) robot pracuje poprawnie
   deklaracja 1000 chwytów = 30.00 kg, waga 29.40 kg, rozjazd -0.60 kg
   werdykt: ok
   do magazynu weszło: 29.40 kg jako ZR/…/BIN-A-…

B) robot gubi materiał, którego nie zgłasza jako porażki
   deklaracja 1000 chwytów = 30.00 kg, waga 24.00 kg, rozjazd -6.00 kg
   werdykt: overclaim  → flaga na maszynę
   do magazynu weszło: 24.00 kg jako ZR/…/BIN-B-…

Zlecenie zamknięte: 53.40 kg w 2 partiach.
```

Obie partie weszły do magazynu w masie z wagi. Różnica między nimi nie jest
w magazynie - jest w ocenie maszyny.

```bash
yarn mercato work_orders prove     # cały łańcuch, idempotentny
yarn mercato work_orders status    # zlecenia z rozjazdem
yarn mercato work_orders weigh --container BIN-A --kg 29.4   # praca operatora
```

Ekran: `/backend/work_orders`, uprawnienie `work_orders.view`.

## Co ujawniło zderzenie z platformą

**Osiem modułów robotycznych nigdy nie dotknęło kontroli zakresu platformy.**
Wołały wyłącznie własne komendy, więc uchodził im skrócony kształt kontekstu
(`selectedId` + `filterIds`). Most jako pierwszy woła komendy rdzenia
(`wms.lots.create`, `wms.inventory.receive`), a te sprawdzają `allowedIds`
i `tenantId` - i odbiły go `Forbidden` bez wskazania przyczyny. Moduł
`sortownia` miał to poprawnie od początku, bo od początku pisał do magazynu.

**Słownik odniesień w WMS nie ma pozycji na produkcję własną.** Dopuszcza
zakup, sprzedaż, przesunięcie, ręczne, kontrolę jakości i zwrot. Materiał
wytworzony na miejscu przez własną maszynę nie mieści się w żadnej z nich.
Wybraliśmy `manual` jako najmniej fałszywą i zapisaliśmy prawdziwe pochodzenie
w metadanych; naciąganie `po` zrobiłoby z własnej produkcji dostawę od
kontrahenta, którego nie ma.

**Magazyn wymaga realnego wykonawcy ruchu i ma rację.** Komenda **odmawia**
zamknięcia niezerowej partii bez wykonawcy, zamiast podstawić „pierwszego
lepszego" użytkownika. Wiersz poleceń wypisuje, komu przypisał ruch.

**Adresy użytkowników są szyfrowane w spoczynku** - surowy `SELECT` wypisał
operatorowi szyfrogram na ekran. Ta sama pułapka, która wyszła już raz
w pulpicie sortowni, złapana po raz drugi w innym module.

## Dwa własne błędy, obie znanej klasy

**Epizody przeciekły między partiami.** Pierwsza wersja dowodu rozstawiała
epizody względem otwarcia partii, a zamykała ją bieżącym czasem - okno zależało
od tego, jak szybko szyna przemieli tysiąc zapisów. 749 epizodów partii A
wypadło poza jej okno i doliczyło się do partii B. Dowód mierzył wydajność
maszyny, na której działa, zamiast zachowania systemu. **Ta sama klasa błędu,
co w fazie 4.**

**Dowód nie był idempotentny.** Drugi przebieg doliczał epizody pierwszego
(2000 zamiast 1000). Naprawione celowanym usunięciem **wyłącznie własnych**
epizodów dowodu, rozpoznanych po przedrostku odniesienia zewnętrznego.
**Ta sama klasa błędu, co w fazie 5.**

Obie wracają, bo obie wynikają z jednego: dowód operujący na czasie rzeczywistym
i na wspólnej bazie jest częścią systemu, który bada.

## Czego ten most nie robi

- **Nie widział prawdziwej wagi ani prawdziwego robota.** Epizody pochodzą
  z komendy `prove`, masa z argumentu.
- **Masa nominalna sztuki jest deklarowana**, nie mierzona. Jest to
  najbardziej niepewna liczba w module i stoi na zleceniu, a nie w konfiguracji
  globalnej, właśnie dlatego.
- **Nie zleca pracy.** Zlecenie robocze zakłada człowiek - patrz decyzja trzecia.
- **Nie rozdziela materiału między pojemniki.** Epizod wiąże z partią okno
  czasowe celi. Robot nie wie, do którego pojemnika trafiła sztuka, i udawanie,
  że wie, byłoby wymyślaniem danych.

# System wizualny - dlaczego pierwsza wersja była źle zaprojektowana

Moduł `hmi`. Powstał po tym, jak rzut hali dostał słuszną ocenę „brzydko
i slopowo". Krytyka była trafna, ale problem nie był estetyczny - był
konkretny i nazywalny.

## Błąd: pokolorowaliśmy stan normalny

Pierwsza wersja rysowała każdą maszynę jako kolorową kropkę: zieloną, gdy
pracuje. Pięć pracujących maszyn dawało ścianę zieleni, w której czerwony
sygnał **musiał się bić o uwagę** zamiast po prostu wyskoczyć z tła.

Doktryna wysokowydajnego HMI, sformalizowana w [ISA-101](https://blog.isa.org/the-high-performance-hmi),
mówi dokładnie odwrotnie:

| Zasada | Co robiliśmy |
| --- | --- |
| stan normalny w szarościach, [kolor zarezerwowany dla odstępstwa](https://industrialmonitordirect.com/blogs/knowledgebase/isa-101-high-performance-hmi-design-principles-color-strategy) | zielony na każdej pracującej maszynie |
| [nigdy sam kolor](https://www.realpars.com/blog/high-performance-hmi) - kodowanie nadmiarowe kształtem i tekstem | kolor był jedynym nośnikiem |
| identyfikator czytelny wprost | kropka bez podpisu |
| jedna hierarchia ważności na wszystkich ekranach | brak hierarchii |

Kropka niesie **jeden bit**. Maszyna ma cztery wymiary: tożsamość, cykl życia,
kalibrację i łączność.

## Czego **nie** kopiujemy

Tła RGB 192,192,192 z dyspozytorni. To ekran w panelu administracyjnym z trybem
jasnym i ciemnym - bierzemy zasadę (norma neutralna, kolor = odstępstwo), nie
konkretną szarość. Udawanie sterowni w ERP byłoby kopiowaniem formy zamiast
treści.

## Co powstało

**Żetony** (`lib/tokens.ts`) - sześciostopniowa hierarchia ważności, paleta
w HSL (w trybie ciemnym zmienia się jasność, nie odcień, bo barwa niesie
znaczenie), siatka odstępów, skala typograficzna.

Jedna decyzja warta wypisania: **`unknown` waży więcej niż `advisory`**.
„Nie wiem, co się dzieje z tą maszyną" jest gorszą wiadomością niż „wiem
i za dwa tygodnie trzeba będzie coś zrobić".

**Słownik stanów** (`lib/status.ts`) - jedno miejsce, w którym fakt
z dziedziny zamienia się w coś rysowalnego. Każdy deskryptor niesie kod,
wagę, **kształt**, etykietę pełną i **formę krótką**.

**Elementy** (`components/primitives.tsx`) - glify jako ścieżki SVG, kafelek
maszyny zamiast kropki, pasek odchylenia od celu, legenda.

## Trzy reguły egzekwowane testem, nie zaleceniem

Zalecenie trafia do dokumentu, którego nikt nie czyta przy dodawaniu nowego
stanu. Test przy tym samym dodaniu po prostu nie przechodzi.

1. **Każdy stan odbiegający od normy ma kształt i tekst.** Operator
   z zaburzeniem rozróżniania barw, ekran w słońcu i wydruk czarno-biały to
   trzy sytuacje, w których sam kolor nie niesie niczego - a każda zdarza się
   na hali częściej niż awaria, której ekran ma dotyczyć.
2. **Stan normalny nie ma glifu.** Ekran, na którym każda maszyna nosi znaczek
   „w porządku", zużywa całą uwagę na potwierdzanie, że nic się nie dzieje.
3. **Forma krótka jest naprawdę krótka** (≤ 18 znaków). Automatyczne cięcie
   daje „Agent nigdy się …", z czego nie wynika nic. Człowiek piszący etykietę
   potrafi skrócić ją tak, żeby coś znaczyła - ale tylko jeśli coś go do tego
   zmusi.

Legenda składa się **ze słownika**, nie z ręcznej listy: ręczna rozjechała się
w tym projekcie dwa razy. Dodatkowo zawężona do stanów obecnych na rysunku -
pełny słownik zamieniłby legendę w drugi ekran do czytania.

## Co znalazł zrzut ekranu, czego nie znalazł kod

Weryfikacja przez HTTP 200 nie wyłapałaby żadnej z tych rzeczy.

**Dwie z pięciu maszyn po prostu znikały z rysunku.** Kafelki nie mieściły się
w obrysie celi i strażnik `return null` usuwał je bez śladu. Plan hali,
z którego znikają maszyny, jest **gorszy niż brak planu** - bo wygląda na
kompletny. Teraz nadmiar dostaje kafelek zbiorczy „+N - otwórz celę",
a kolejność idzie wg ważności, więc ucięte są zawsze maszyny w normie.

**Układ marnował połowę celi.** Kafelki szły w jedną kolumnę w celi mającej
miejsce na dwie. Rachunek wyjechał z JSX do `lib/pack.ts` - arytmetyka w JSX
jest arytmetyką, której nikt nie przetestuje.

**Napisy wychodziły poza kafelek** i nachodziły na glif. SVG nie zawija ani
nie przycina tekstu sam.

## Jedna rzecz, którą rozstrzygnąłem dopiero pod presją testu

Co zrobić, gdy cela jest **węższa niż czytelny kafelek**. Nie ściskamy kafelka
poniżej obrysu - wystawałby poza celę, do której należy, i rzut zacząłby
kłamać o przynależności. Nie rozciągamy celi. Zamiast tego `packTiles` zwraca
`constrained: true` i niech będzie widać, że przy tym obmiarze opis się utnie.

## Stan po przebudowie

Na naszej instancji **wszystkie** maszyny są w stanie odbiegającym od normy,
bo żaden agent nie bije serca od godzin. Zdrowa hala wyglądałaby inaczej:
same neutralne kafelki, pusty pas uwagi, kolor wyłącznie tam, gdzie coś się
dzieje. **To jest właściwy test tego projektu** - i jednocześnie powód,
dla którego na zrzucie wygląda alarmowo.

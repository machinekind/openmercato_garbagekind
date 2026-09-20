# Mapa faz - od rejestru floty do zbiorów treningowych

Dekompozycja operacyjna z raportu rozpoznawczego. Ten plik jest źródłem prawdy
dla kolejności prac: faza zamknięta to faza z działającym dowodem na żywej
instancji, a nie z zieloną suitą testów.

## Zasady wspólne dla wszystkich faz

1. **Maksymalne użycie Open Mercato.** Zapis idzie szyną komend, uprawnienia
   przez `acl.ts` + `setup.ts` (eksport `default` **i** nazwany - sam
   `defaultRoleFeatures` przechodzi bez błędu i bez skutku), encje przez
   MikroORM z jawną migracją, ekran przez `backend/<nazwa>/page.tsx`.
2. **Granice modułów są treścią projektu, nie porządkowaniem plików.** Każda
   faza ma wypisane, czego w module **nie ma** i dlaczego.
3. **Dowód zaliczenia jest zdaniem o zachowaniu systemu**, nie listą plików.
4. **Każda decyzja z kuszącą alternatywą trafia do tabeli w README** razem
   z powodem odrzucenia alternatywy.
5. Nie wolno rozluźniać asercji, żeby test przeszedł. Czerwony test
   krzyżowy jest informacją, a nie przeszkodą.

## Faza 0 - `fleet` + `edge` - ZAMKNIĘTA

Rejestr floty (co istnieje, gdzie stoi, czy wolno mu pracować) i kanał
brzegowy (kto się odzywa, czym to udowadnia, kiedy odezwał się ostatnio).
Dowód: `online → late → lost` bez żadnego zapisu w międzyczasie; po HTTP
wpis i heartbeat 200, powtórka numeru / obcy klucz / zużyty bilet → 401.

## Faza 1 - `policy_registry`

**Dostarcza:** wersjonowany rejestr polityk (wyuczonych sterowników) i ich
artefaktów. `Policy`, `PolicyVersion`, `Artifact` (wagi, konfiguracja,
preprocesory), powiązanie wersji z **rewizją embodimentu**, nie z robotem.

**Rdzeń decyzyjny:** wersja polityki jest niezmienna, a jej tożsamością jest
skrót artefaktu. Dwa wgrania tych samych wag to jedna wersja. Polityka bez
zadeklarowanego embodimentu nie daje się zapisać - to jedyne miejsce, w którym
da się powiedzieć „ta polityka fizycznie nie może działać na tym sprzęcie"
*przed* wdrożeniem.

**Czego tu nie ma:** wdrożenia, stanu pożądanego, wyników ewaluacji.

**Dowód:** próba zarejestrowania wersji dla embodimentu o innym
`spec_digest` odbija się z nazwanym powodem; powtórne wgranie tych samych
wag nie tworzy drugiej wersji.

## Faza 2 - `deployment` - kanał stanu pożądanego

**Dostarcza:** deklarację „ten robot ma uruchomić tę wersję polityki",
dzierżawę (lease) o długości zależnej od `risk_class` celi i uzgadnianie
stanu faktycznego z pożądanym.

**Rdzeń decyzyjny:** dzierżawa jest **odwrotnością** heartbeatu. Heartbeat
mówi centrali, że robot żyje; dzierżawa mówi robotowi, jak długo wolno mu
pracować bez potwierdzenia z centrali. Cela ogrodzona - dni, przestrzeń
dzielona - godziny, publiczna - minuty. Odcięcie chmury nie może zatrzymać
produkcji w celi ogrodzonej i **musi** zatrzymać ją w przestrzeni publicznej.

**Czego tu nie ma:** treści polityki (to `policy_registry`), tożsamości
agenta (to `edge`).

**Dowód:** po wygaśnięciu dzierżawy robot w celi `public` przechodzi do stanu
niepracującego bez udziału centrali; ten sam robot w celi `fenced` pracuje dalej.

## Faza 3 - `episodes` - epizody i interwencje

**Dostarcza:** epizod jako atom pracy (dla manipulatorów stacjonarnych to
naturalna jednostka), wynik epizodu, oraz **interwencję człowieka** jako
pierwszorzędny obiekt: kto, kiedy, na jakim etapie i dlaczego przerwał.

**Rdzeń decyzyjny:** interwencja nie jest błędem do ukrycia w logach - jest
główną miarą dojrzałości wdrożenia i wejściem do następnego treningu. Liczba
epizodów między interwencjami to jedyna liczba, która naprawdę mówi, czy
wdrożenie idzie do przodu.

**Dowód:** raport „epizody między interwencjami" liczony per polityka i per
cela, zgodny co do sztuki z księgą epizodów.

## Faza 4 - `rollout` - wdrożenia etapowe z bramami

**Dostarcza:** wdrożenie wersji polityki na flotę etapami, z bramą między
etapami i automatycznym wycofaniem po przekroczeniu progu.

**Rdzeń decyzyjny:** brama odwołuje się do liczb z fazy 3, nie do opinii.
Wycofanie jest tańsze niż diagnoza, więc jest domyślne. Tryb cieniowy ma
zapisane ograniczenie: cień nie dowodzi bezpieczeństwa dla polityki, która
zmienia stan świata - dowodzi tylko zgodności predykcji.

**Dowód:** przekroczenie progu interwencji na etapie 1 zatrzymuje etap 2
i wycofuje etap 1 bez udziału człowieka.

## Faza 5 - `safety` - uzasadnienie, ewaluacja, incydenty

**Dostarcza:** uzasadnienie bezpieczeństwa wiązane z **klasą celi**, zestawy
ewaluacyjne wymagane przed dopuszczeniem, rejestr incydentów z klasyfikacją.

**Rdzeń decyzyjny:** to jest warstwa, która odpowiada regulatorowi
(rozporządzenie maszynowe 2023/1230, stosowane od 20 stycznia 2027;
AI Act art. 6 ust. 1; ISO 10218-1/-2:2025; ISO/TS 15066:2016). Dopuszczenie
dotyczy klasy celi, nie pojedynczej celi - inaczej każda nowa cela wymaga
osobnego uzasadnienia dla niezmienionej konfiguracji.

**Dowód:** wersja polityki bez kompletu przejść ewaluacyjnych nie daje się
wdrożyć w celi klasy, dla której uzasadnienie nie zostało zatwierdzone.

## Faza 6 - `datasets` - zbiory danych

**Dostarcza:** zbiory budowane z epizodów i interwencji, wersjonowane
i powiązane z wersjami polityk, które z nich powstały.

**Rdzeń decyzyjny:** zamknięcie pętli. Zbiór musi umieć odpowiedzieć, z jakich
epizodów powstał i która polityka się na nim uczyła - inaczej regres jakości
po treningu jest nie do zdiagnozowania.

**Dowód:** dla dowolnej wersji polityki da się wskazać zbiór, a dla zbioru -
listę epizodów źródłowych, i odwrotnie.

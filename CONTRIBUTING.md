# Współpraca przy projekcie

## Zasada nadrzędna

Ten kod steruje ewidencją odpadów i dopuszczaniem do pracy maszyn poruszających
się w przestrzeni z ludźmi. **Nie wolno rozluźniać asercji, żeby test przeszedł,
ani oznaczać jako sprawdzone czegoś, czego nie sprawdzono na stanowisku.**
Dowód zaliczenia to zdanie o zachowaniu systemu, a nie zielony wynik.

## Zanim zaczniesz

Repozytorium zawiera moduły rozszerzające Open Mercato, ale **nie zawiera samej
platformy**. Żeby cokolwiek uruchomić, potrzebny jest osobny klon Open Mercato:

```bash
git clone <open-mercato> ~/open-mercato
export MERCATO_ROOT=~/open-mercato
./mercato/install.sh                      # kopiuje moduły do apps/mercato
(cd "$MERCATO_ROOT/apps/mercato" && yarn generate && yarn mercato db migrate)
```

Moduły są **kopiowane**, nie dowiązywane — Turbopack nie rozwiązuje dowiązań
poza katalogiem projektu. Źródłem prawdy zostaje to repozytorium; po każdej
zmianie uruchom `install.sh` ponownie.

## Przed każdym pushem

```bash
./mercato/install.sh
(cd "$MERCATO_ROOT/apps/mercato" && yarn typecheck && yarn test)
python3 -m unittest discover -s tests -p 'test_*.py'
```

Wszystkie trzy muszą przejść. CI (`.github/workflows/ci.yml`) uruchamia część
pythonową i statyczne kontrole; część TypeScript wymaga platformy, więc
odpowiedzialność za nią leży po stronie autora zmiany.

## Zasady inżynierskie obowiązujące w tym repozytorium

1. **Zapis wyłącznie szyną komend.** Każda mutacja przechodzi przez
   `commandBus.execute`, więc zostawia wpis w dzienniku audytu z aktorem
   i stanem przed/po. Zapis z pominięciem szyny nie przejdzie przeglądu.
2. **Uprawnienia w `acl.ts` i `setup.ts`**, encje przez MikroORM z jawną
   migracją, ekran przez `backend/<nazwa>/page.tsx`.
3. **Każda decyzja z kuszącą alternatywą trafia do komentarza wraz z powodem
   odrzucenia.** Komentarz ma tłumaczyć *dlaczego*, nie *co* — „co" widać
   w kodzie.
4. **Moduł nie importuje encji innego modułu.** Klasa encji zarejestrowana pod
   dwiema ścieżkami daje „Metadata for entity X not found" po stronie, która
   zgubi kolejność ładowania. Odczyt z obcej tabeli idzie surowym SQL-em,
   logika współdzielona — przez plik czystych funkcji w `lib/`.
5. **Plik z komendami nie jest biblioteką.** Funkcje pomocnicze wołane spoza
   komend przenosimy do `lib/`, inaczej leniwy loader szyny zarejestruje
   komendę drugi raz.
6. **Każda faza wypisuje, czego w module nie ma i dlaczego.**

Pełne uzasadnienia: [`README.md`](README.md), sekcja „Zasady inżynierskie".

## Zdarzenia

Trzy reguły częstotliwości, których nie wolno naruszać:

- **ruch nie jest faktem** — uderzenie serca nie emituje zdarzenia, jego brak tak;
- **wyzwalanie zboczem** — rozjazd trwający pół godziny to jedno zdarzenie,
  nie sto;
- **odhaczanie w danych** — wygaśnięcie kalibracji ogłaszane raz na kalibrację.

Zdarzenie zadeklarowane w `events.ts` bez `emit` w kodzie jest błędem.

## Granice, których nie wolno przekroczyć

- Platforma **nie wysyła poleceń trajektorii** i **nie zatrzymuje maszyny**.
  Zatrzymanie natychmiastowe należy do deterministycznej warstwy bezpieczeństwa
  poza platformą. Endpoint, który „przerywa" zadanie, oznacza rekord.
- **Wyuczona polityka nie może być funkcją bezpieczeństwa.** Deklaracja
  `declaredAsSafetyFunction: true` blokuje dopuszczenie i tak ma zostać.
- **Nagrania z osobą w kadrze** mają wymuszoną retencję trzymiesięczną
  (art. 22² Kodeksu pracy). Alarm o przeterminowanym klipie nie cichnie sam
  i to jest zamierzone.
- **Dane demonstracyjne pozostają fikcyjne.** Nie wprowadzamy nazw istniejących
  podmiotów ani numerów przypisanych do rzeczywistych podatników.

## Język

Dokumentacja i komentarze są po polsku, bo zespół i odbiorca produktu są
polskojęzyczni. Identyfikatory w kodzie — nazwy zmiennych, funkcji, pól bazy,
kluczy zdarzeń — są po angielsku. Ta granica jest celowa i prosimy jej nie
zacierać w żadną stronę.

## Zgłaszanie podatności

Nie przez zgłoszenie publiczne — patrz [`SECURITY.md`](SECURITY.md).

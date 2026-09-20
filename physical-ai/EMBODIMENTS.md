# Kafelek embodimentu - format, wzorzec i to, co wzorzec zepsuł

SO-101 jest tu pierwszym prawdziwym ramieniem skonfrontowanym z modelem
zbudowanym w fazach 0-6. Wybrany dlatego, że jest **dobrze udokumentowany**:
jeśli format nie daje się wypełnić dla niego, dla ramienia bez dokumentacji nie
ma szans.

Źródła: [dokumentacja LeRobot SO-101](https://huggingface.co/docs/lerobot/main/so101),
[TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100).
Stan: **wyłącznie z dokumentacji, bez weryfikacji na sprzęcie** - i tak jest to
zapisane w polu `provenance.verifiedAgainstHardware`.

## Zasada formatu

**Niewiedza ma być widoczna w danych, a nie schowana w wartości domyślnej.**

Pole, którego nikt nie zna, dostaje wartość `"unknown"`. Opis z takimi polami
jest `valid`, ale nie `complete`: wolno go zaewidencjonować, nie wolno na jego
podstawie dopuścić polityki do ruchu. Inwentaryzacja ramienia, o którym nie wie
się wszystkiego, jest tym, od czego zaczyna się każde wdrożenie - odmowa zapisu
wypchnęłaby te maszyny poza system, czyli tam, gdzie już są.

Dla SO-101 z samej dokumentacji nie da się ustalić **udźwigu** ani **zasięgu**.
Format to przyznaje, zamiast wpisać liczbę, której nikt nie zmierzył.

## Co się zmieniło w platformie

`spec_digest` jest teraz **liczony** z kanonicznej postaci opisu, a nie
deklarowany przez wgrywającego. Odcisk podawany przez tego samego, kto podaje
specyfikację, porównywał deklarację sam ze sobą i nie stwierdzał niczego.

Z odcisku wypadają prowenancja i nazwa własna: dopisanie źródła albo poprawienie
literówki nie zmienia fizyki ramienia, a zmieniony odcisk unieważniłby zgodność
wszystkich polityk. Zmiana przełożenia w jednym stawie - owszem, zmienia.

Rewizja jest niezmienna. Import tego samego pliku drugi raz nic nie robi; import
innego kontraktu pod tym samym numerem rewizji jest odrzucany.

```bash
yarn mercato fleet embodiment --file mercato/embodiments/so101_follower.json
```

## Cztery rzeczy, które SO-101 w naszym modelu zepsuł

### 1. Ważność kalibracji jest u nas czasowa, a w rzeczywistości zdarzeniowa

`Calibration.validUntil` jest polem obowiązkowym i uzasadnialiśmy to tak:
„kalibracja bez daty ważności jest kalibracją, o której nikt nigdy nie
przypomni". Dla ramienia przemysłowego to prawda.

Dla SO-101 - nie. `lerobot-calibrate` nie produkuje żadnej daty ważności.
Kalibracja jest ważna **dopóki nie zajdzie zdarzenie**: ponowny montaż,
poluzowanie orczyka, wymiana serwomechanizmu, kolizja wypychająca staw poza
zakres, zmiana `drive_mode` lub identyfikatora na magistrali. Nasz model zmusza
do wpisania wymyślonej daty, a wymyślona data w polu, na którym stoi bramka
dopuszczenia, jest gorsza niż brak daty.

**Do naprawy:** ważność kalibracji jako suma warunku czasowego i listy zdarzeń
unieważniających, z co najmniej jednym wymaganym. Nie zgadywać daty.

### 2. Klasa ryzyka myli bliskość człowieka ze zdolnością do wyrządzenia krzywdy

Mamy `fenced | shared | public` i wiążemy z nimi długość dzierżawy. SO-101 stoi
na biurku, ręka człowieka jest przy nim bez przerwy - więc wpada do `shared`
i dostaje krótką dzierżawę.

To jest zła diagnoza z właściwym skutkiem. Ramię wydrukowane na drukarce 3D,
napędzane serwomechanizmami hobbystycznymi z przełożeniem 1/345, **nie jest
w stanie zrobić człowiekowi krzywdy**. Krótka dzierżawa wynika u nas z tego, że
człowiek jest blisko - a powinna wynikać z tego, ile energii maszyna może
przekazać. To są dwie różne osie i zlaliśmy je w jedną.

Oś, której brakuje, jest opisana: ograniczenie mocy i siły w rozumieniu
ISO/TS 15066:2016. Bez niej każdy manipulator stołowy będzie traktowany jak
robot przemysłowy stojący obok człowieka.

**Do naprawy:** `riskClass` rozbite na `proximity` i `energyClass`. Dzierżawa
liczona z obu.

### 3. Kamery nie są cechą ramienia, a przesądzają o zgodności polityki

`spec_digest` miał być tym miejscem, w którym da się powiedzieć „ta polityka
fizycznie nie zadziała na tym sprzęcie" przed wdrożeniem. Dla przestrzeni akcji
to prawda - sześć stawów, nazwy, przełożenia.

Dla przestrzeni **obserwacji** to nieprawda. Polityka wytrenowana z dwiema
kamerami nie ruszy na stanowisku z jedną, a liczba i rozmieszczenie kamer nie
należą do ramienia - są cechą celi. Odcisk kontraktu embodimentu jest więc
warunkiem koniecznym zgodności, ale nie wystarczającym, a my traktowaliśmy go
jak wystarczający.

**Do naprawy:** kontrakt obserwacji po stronie celi, sprawdzany razem
z odciskiem embodimentu.

### 4. Zestaw wymaganych artefaktów zależy od wersji środowiska uruchomieniowego

W rejestrze polityk `Artifact.role` ma unikat `(policy_version_id, role)`
i milcząco zakłada stały słownik ról. LeRobot pokazuje, że tak nie jest:
`config.json` i `model.safetensors` są zawsze, `train_config.json` niesie
pochodzenie treningu, a nowsze wydania wymagają `policy_preprocessor.json`,
którego starsze repozytoria polityk **nie zawierają** - co jest zgłoszonym
błędem w LeRobot, nie hipotezą.

Wymagany zestaw jest więc funkcją wersji środowiska, a nie stałą. Nasz rejestr
umie powiedzieć „ta wersja ma te pliki", ale nie „te pliki wystarczą dla tego
środowiska".

**Do naprawy:** deklaracja środowiska uruchomieniowego przy wersji polityki
i sprawdzanie kompletu ról względem niego.

## Dwie rzeczy, które dokumentacja potwierdziła

**Kalibracja jest warunkiem dopuszczenia polityki, nie czynnością serwisową.**
Nie jest to nasza interpretacja - dokumentacja LeRobot mówi wprost, że proces
kalibracji jest tym, co pozwala sieci wytrenowanej na jednym robocie działać na
innym. Decyzja z fazy 0, żeby bramkować przejście do stanu `ready` kalibracją,
była trafna.

**Deterministyczna warstwa bezpieczeństwa istnieje i jest osobna od polityki.**
`max_relative_target` ogranicza skok zadanej pozycji względem bieżącej,
domyślnie 5 stopni, i jest egzekwowany w sterowniku, nie w sieci. Dokładnie
tego wymaga zatwierdzenie uzasadnienia bezpieczeństwa w fazie 5.

Z jednym zastrzeżeniem, które trzeba dopisać do modelu: **ten limit da się
wyłączyć** ustawieniem na `null`. Uzasadnienie bezpieczeństwa nie może więc
poprzestać na stwierdzeniu, że warstwa istnieje - musi zapisać jej **wartość**
i mieć sposób na sprawdzenie, że nie została zdjęta.

## Następny krok, gdy sprzęt będzie podłączony

Kolejność jest istotna, bo każdy punkt sprawdza inne twierdzenie:

1. **Odczytać kontrakt z magistrali** i porównać z plikiem. Identyfikatory
   i modele serwomechanizmów są odczytywalne - odcisk przestanie zależeć od
   tego, co ktoś wpisał.
2. **Wykonać `lerobot-calibrate`** i wciągnąć prawdziwy plik kalibracji jako
   rekord `joint_offsets`. To unieważni punkt 1 z listy usterek albo go
   potwierdzi.
3. **Policzyć sha256 prawdziwego `model.safetensors`** i wgrać jako artefakt.
   To zamyka główną lukę fazy 1: odcisk artefaktu przestaje być deklaracją.
4. **Zatrzymać ramię z poziomu platformy** - wyłączeniem momentu na magistrali.
   To jest pierwszy moment, w którym zdanie „platforma potrafi zatrzymać
   maszynę" przestanie być nieprawdziwe.

Punkt 4 jest właściwym testem. Reszta to ewidencja.

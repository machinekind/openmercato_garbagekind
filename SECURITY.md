# Polityka bezpieczeństwa

## Zgłaszanie podatności

Podatności **nie zgłaszamy przez publiczne issue**. Prosimy o kontakt na adres
bezpieczenstwa zespołu Machinekind wraz z opisem, krokami odtworzenia i oceną
wpływu. Potwierdzamy przyjęcie zgłoszenia i informujemy o postępach.

Prosimy o nieujawnianie szczegółów publicznie do czasu udostępnienia poprawki.

## Zakres o podwyższonym znaczeniu

Ten projekt prowadzi ewidencję dopuszczania do pracy maszyn poruszających się
w przestrzeni z ludźmi. Zgłoszenia dotyczące poniższych obszarów traktujemy
priorytetowo:

| Obszar | Dlaczego |
| --- | --- |
| Kanał brzegowy (`/api/edge/*`, `/api/deployment/*`) | podszycie się pod agenta pozwala fałszować stan maszyny |
| Bramka dopuszczenia (`safety.clearance.check`) | obejście dopuszcza maszynę bez uzasadnienia bezpieczeństwa |
| Bramka kalibracji (`fleet.robots.transition`) | obejście dopuszcza maszynę bez ważnego dowodu kalibracji |
| Retencja nagrań (`vision.clips.*`) | naruszenie art. 22² Kodeksu pracy |
| Izolacja tenanta i organizacji | sięgnięcie poza własny zakres danych |

## Model zagrożeń kanału brzegowego

Założenie, które przesądza o kształcie reszty: **klucz prywatny agenta nigdy nie
opuszcza robota.** Centrala zna wyłącznie klucz publiczny, więc wyciek bazy nie
pozwala podszyć się pod maszynę.

Z tego wynikają mechanizmy, których naruszenie jest podatnością:

- **Ed25519** - komunikat jest dowodem posiadania klucza, nie deklaracją.
  Endpoint przyjmujący samą deklarację („jestem agentem X") chroniłby przed
  niczym.
- **Przedrostki wiążące kontekst** - `edge.enroll:`, `edge.connect:`,
  `edge.heartbeat:`, `edge.telemetry:`, `edge.rotate:`, `deployment.lease:`,
  `deployment.report:`. Podpis zebrany pod jednym przedrostkiem **nie może**
  przejść pod innym. Bez tego przechwycone uderzenie serca przedłużałoby
  mandat do pracy.
- **Rosnący licznik sekwencji per sesja** - powtórzony numer jest odtworzeniem
  i musi być odrzucony.
- **Odcisk klucza liczony z postaci DER/SPKI**, nie z tekstu PEM - ten sam klucz
  z innymi końcami wierszy dałby inny odcisk tekstowy, a operator porównujący
  odcisk z ekranu robota zobaczyłby rozbieżność tam, gdzie jej nie ma.
- **Rotacja klucza podpisywana nowym kluczem** - dowodem jest posiadanie
  następcy, nie poprzednika.

Zgodność implementacji agenta z centralą sprawdza zestaw
`mercato/hardware/edge_agent/conformance.mts`, który ładuje **te same moduły,
których używa serwer**, i weryfikuje nimi podpisy złożone przez agenta.

## Czego ta platforma nie zapewnia

Podane wprost, żeby nikt nie oparł na niej założenia, którego nie unosi:

- **Platforma nie zatrzymuje maszyny.** Zatrzymanie natychmiastowe należy do
  deterministycznej warstwy bezpieczeństwa, która nie przechodzi przez tę
  platformę. Endpoint oznaczający zadanie jako przerwane **oznacza rekord**,
  a nie hamuje ramienia.
- **Przycisk w aplikacji nie jest wyłącznikiem awaryjnym.** Nigdy nim nie będzie.
- **Wyuczona polityka nie jest funkcją bezpieczeństwa** i platforma odmawia
  dopuszczenia uzasadnienia, które tak ją deklaruje.

## Dane demonstracyjne

Wszystkie dane generowane przez `legacy/generate.py` są fikcyjne - patrz
[`NOTICE`](NOTICE). Instancje demonstracyjne nie zawierają danych osobowych ani
rzeczywistych danych handlowych.

## Zależności obce

Składniki obce i ich licencje wylicza [`NOTICE`](NOTICE). Materiał archiwalny
w `physical-ai/evidence/` **nie jest zależnością** - żaden moduł go nie importuje
ani nie uruchamia. Skrypty diagnostyczne z tego katalogu nie powinny być
uruchamiane bez ponownego przeglądu bezpieczeństwa; źródłowy raport wprost
oznacza jeden z nich jako taki, którego nie należy uruchamiać w obecnej postaci.

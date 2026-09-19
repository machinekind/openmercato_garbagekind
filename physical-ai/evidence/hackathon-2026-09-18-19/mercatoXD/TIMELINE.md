# Oś czasu materiału

| Data (Europe/Warsaw) | Zdarzenie | Dowód |
|---|---|---|
| 2026-08-23 | Fizyczna diagnostyka A1X/A1XY na CAN-FD. Pomiary obejmują telemetrię 200 Hz, mapowanie kodów funkcyjnych, zachowanie pól sterujących i incydent ruchu 76,36° przy nasyconym momencie. | `source/robot/diag/REPORT.md`, `source/robot/docs/STEERING.md`, `source/robot/docs/VENDOR_SDK.md` |
| 2026-09-18 | Początek udokumentowanych sesji hackathonowych: SO-101, wybór modeli, panel A1X, transmisja obrazu i przygotowanie prób VLA. | `source/docs/knowledge/so101-trash.md`, `400-cdc-d9d.md`, `7fb26521.md` |
| 2026-09-19 | Panel A1X, tracking, uruchomienie G0.5 na DGX, próby dojścia i chwytu, poprawa po montażu kamery nadgarstkowej. | `source/docs/knowledge/d7ea01b3.md`, `source/docs/PICK-STATE-OF-PLAY.md` |
| 2026-09-19 21:37:49 +02:00 | Utworzenie jedynego źródłowego commita zbierającego materiały. | commit `fd5fe08f24ae35fe37c8053086327fdc1a14363a` |
| 2026-09-19 22:54 +02:00 | Import materiału dowodowego do `openmercato_garbagekind`, bez modyfikowania zawartości plików pod `source/`. | `SOURCE.json`, `MANIFEST.sha256` |

## Granice osi czasu

- Okres hackathonu udokumentowany w notatkach to 18–19 września 2026 r.
- Raport z 23 sierpnia jest wcześniejszym pomiarem sprzętowym dołączonym do
  paczki podczas hackathonu.
- Daty w notatkach pochodzą z ich treści. Git nie pozwala odtworzyć historii
  poszczególnych plików, ponieważ repozytorium źródłowe ma jeden zbiorczy commit.

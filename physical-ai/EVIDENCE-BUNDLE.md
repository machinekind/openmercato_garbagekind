# Paczka dowodowa przebiegu Physical AI

Każda próba fizyczna ma jeden katalog i jeden `runRef`. Paczka zachowuje
również wyniki negatywne: nieudana próba z kompletem danych jest ważnym
dowodem; brak pliku, uszkodzony skrót albo brak wymaganej próby jest wadą
samej paczki.

Walidator:

```powershell
py -3.12 mercato\hardware\evidence_bundle.py D:\evidence\SO101-0001\<runRef>
```

Przed dopuszczeniem P0 należy dodać `--require-p0-pass`. Bez tej flagi
walidator potwierdza integralność i pokazuje wynik bramy, ale nie odrzuca
uczciwie zapisanego niepowodzenia próby.

## Zawartość katalogu

```text
<runRef>/
  run.json
  hardware.json
  calibration.json
  safety.json
  telemetry.ndjson
  interventions.ndjson
  media-index.json
  checksums.sha256
```

Można dodawać kolejne pliki, ale każdy musi znaleźć się w
`checksums.sha256`. Dowiązania symboliczne i ścieżki wychodzące ponad katalog
są zabronione. Sam plik sum kontrolnych nie haszuje siebie.

## `run.json`

Wymagane pola:

- `schemaVersion: 1`, UUID `runRef`, stabilny `robotKey` i pseudonimowy
  `operatorRef`;
- `startedAt` i `endedAt` w UTC;
- `embodiment.key`, dodatnia `embodiment.revision` oraz 64-znakowy
  `embodiment.specDigest` zapisany niezależnie przy starcie próby;
- `clockSync.source`, `clockSync.measuredAt` i nieujemne
  `clockSync.maxOffsetMs`.

Wszystkie pozostałe dokumenty i rekordy logów muszą wskazywać ten sam
`runRef`; dokumenty sprzętu i kalibracji również ten sam `robotKey`.

## `hardware.json`

`devices` jest niepustą listą urządzeń o unikalnych rolach. Każde urządzenie
podaje `role`, `model`, `firmware`, `connection` oraz `serialHash`. Numeru
seryjnego nie zapisujemy jawnie — `serialHash` jest jego SHA-256.

## `calibration.json`

Każda pozycja `calibrations` ma unikalny `key` oraz:

- narzędzie `producedBy` i `artifactUri`;
- SHA-256 artefaktu;
- `measuredAt` i późniejsze `validUntil` w UTC;
- nieujemną `uncertainty.value` i jawną `uncertainty.unit`.

## `safety.json`

`deterministicLayer.kind` korzysta z tego samego zamkniętego słownika co ERP,
a pola `implementedIn` i `bypassable` opisują rzeczywistą warstwę lokalną.

Paczka P0 zawiera dokładnie zidentyfikowane próby:

| Rodzaj | Scenariusze |
| --- | --- |
| `estop` | `idle`, `motion`, `grasp` |
| `limit` | `position`, `speed`, `command_timeout` |
| `zone` | `person_in_safety_zone` |

Każdy wpis ma `result: passed|failed`, czas UTC, metodę oraz URI dowodu.
Brak próby unieważnia paczkę. Wynik `failed` zachowuje ważność dowodową, ale
blokuje wariant `--require-p0-pass`.

Próba `zone/person_in_safety_zone` podaje dodatkowo
`interventionExternalRef`. Walidator wymaga rekordu o tym identyfikatorze w
`interventions.ndjson` i sprawdza, czy ma on dokładnie
`reasonCategory: person_in_safety_zone`. Dzięki temu reakcja fizyczna i zapis
alarmu w ERP są jednym dowodem, a nie dwiema niezależnymi deklaracjami.

## Logi NDJSON

Każdy niepusty wiersz jest osobnym obiektem JSON:

- `telemetry.ndjson`: `runRef`, unikalny `externalRef`, `timestamp` UTC,
  nieujemny `sequence` i `stream`;
- `interventions.ndjson`: `runRef`, unikalny `externalRef`, `occurredAt` UTC,
  `kind`, `reasonCategory` oraz opis `reason`.

Rodzaje i kategorie interwencji są zgodne z
[`INTERVENTION-REASONS.md`](INTERVENTION-REASONS.md). Pliki mogą być puste,
jeżeli w przebiegu faktycznie nie było rekordów danego rodzaju; nie wolno
wstawiać rekordu syntetycznego tylko po to, żeby licznik był dodatni.

## `media-index.json`

Każda pozycja podaje `uri`, SHA-256, `cameraKey`, `recordedAt`, późniejsze
`retentionUntil` i jawne `anonymized: true`. URI musi wskazywać magazyn
obiektów, a nie lokalną ścieżkę `file://`. Bajty wideo nie trafiają do ERP ani
do Git.

## `checksums.sha256`

Format każdego wiersza jest zgodny z narzędziami SHA-256:

```text
<64 małe znaki hex><dwie spacje><ścieżka względna POSIX>
```

Walidator odrzuca brakujący, dodatkowy i zmieniony plik. Po zatwierdzeniu
paczki jej katalog powinien zostać zapisany jako niezmienny obiekt w
magazynie edge/DGX; do ERP przekazujemy URI, SHA-256 i podsumowanie wyniku.

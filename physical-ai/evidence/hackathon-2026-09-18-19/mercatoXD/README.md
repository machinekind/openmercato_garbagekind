# Dowody sprzętowe z hackathonu — `mercatoXD`

Ten katalog jest niezmienionym importem dostępnych w repozytorium źródłowym
materiałów sprzętowych z prac hackathonowych z **18–19 września 2026 r.**
Import wykonano 19 września 2026 r. z publicznego repozytorium
[`Bukareszt/mercatoXD`](https://github.com/Bukareszt/mercatoXD) z commita
`fd5fe08f24ae35fe37c8053086327fdc1a14363a`.

Materiały dotyczą przede wszystkim ramion **Galaxea A1X/A1XY**. Wpisy dotyczące
SO-101 są materiałem pomocniczym i nie stanowią fizycznego odbioru naszej
rewizji SO-101.

## Co zachowano

- raport z eksperymentów CAN-FD i 18 skryptów diagnostycznych;
- notatki wydobyte z sesji 18–19 września, wraz z ich znacznikami czasu;
- dokumentację sprzętu, protokołu, bezpieczeństwa, sterowania i SDK;
- stan prób `pick up the can` oraz opis stosu robota;
- konfigurację presetów A1X i pomocniczy URDF SO-101;
- sumy SHA-256 wszystkich niezmienionych plików źródłowych.

Pliki pod `source/` są materiałem archiwalnym. Nie należy uruchamiać skryptów
diagnostycznych bez ponownego przeglądu bezpieczeństwa. W szczególności sam
raport źródłowy oznacza `release_probe.py` jako skrypt, którego nie należy
ponownie uruchamiać w obecnej postaci.

## Daty i wiarygodność

Najważniejsze daty są zebrane w [TIMELINE.md](TIMELINE.md), a szybka mapa
dowodów w [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md). Raport A1X opisuje pomiary z
23 sierpnia 2026 r.; został dostarczony razem z materiałami hackathonowymi z
18–19 września. Nie przesuwamy tej wcześniejszej daty na czas hackathonu.

Repozytorium źródłowe nie zawierało śledzonych surowych plików `.log`, `.raw`,
`.csv`, nagrań ani datasetów, choć raport wymienia ich nazwy. Nie zostały
odtworzone ani zastąpione syntetycznymi danymi. Dostępne „logi” to raport i
notatki sesyjne z dokładnymi komunikatami, pomiarami i znacznikami czasu.

## Zasada dalszego użycia

Ten import jest dowodem i materiałem referencyjnym, nie kodem produkcyjnym.
Wdrożenia do ERP, bridge'a i sterowania robotem powstają w osobnych commitach,
po usunięciu wykrytych luk bezpieczeństwa i integracji z istniejącymi modułami
`fleet`, `edge`, `digital_twins`, `vision` oraz `physical_management`.

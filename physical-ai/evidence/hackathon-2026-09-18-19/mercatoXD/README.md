# Dowody sprzętowe z hackathonu — `mercatoXD`

Ten katalog jest importem dostępnych w repozytorium źródłowym materiałów
sprzętowych i kodu wykonawczego z prac hackathonowych z **18–19 września
2026 r.** Pierwszy import wykonano 19 września, a 20 września uzupełniono go
o pełny tekstowy snapshot tego samego commita z publicznego repozytorium
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
- bridge Open Mercato ↔ A1X wraz z 56 testami, konfiguracją i klientami panelu;
- agenta DGX, panel robota, sterownik ROS2/CAN, teleoperację, rejestrator i
  narzędzia symulacyjne;
- źródłowy moduł `robotics` dla Open Mercato jako materiał porównawczy;
- konfigurację presetów A1X i pomocniczy URDF SO-101;
- sumy SHA-256 wszystkich niezmienionych plików źródłowych.

Nie zaimportowano `robot/.env` ani jedenastu binarnych siatek STL producenta.
Plik środowiska został wyłączony zapobiegawczo, a siatki nie są wynikiem prac
zespołu i podlegają odrębnym warunkom upstream. Skan nie wykrył prywatnych
kluczy ani długich wartości wyglądających na sekret w pozostałym materiale.

Pliki pod `source/` są materiałem archiwalnym i zachowują treść źródła. Nie
należy uruchamiać skryptów
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

Źródłowy bridge przeszedł 20 września **56/56 testów** bez sprzętu przy 84%
pokrycia instrukcji. To potwierdza zachowanie programu w testach, ale nie
zastępuje fizycznego odbioru: repo samo stwierdza, że autonomiczny chwyt nie
zadziałał, a zamknięcie chwytaka pozostaje skryptowane.

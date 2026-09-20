# Gdzie postawić DGX Sparka - i gdzie go nie stawiać

Decyzja sprzętowa, która zmienia architekturę, więc opisana osobno.

## Czym ta maszyna jest

[GB10 Grace Blackwell](https://www.naddod.com/products/103029.html): 128 GB
pamięci **zunifikowanej** LPDDR5X, ~1 PFLOPS w FP4, 20-rdzeniowy Arm i GPU
Blackwell połączone NVLink-C2C. Dwie sztuki da się spiąć po 200 GbE.

Liczba, która rozstrzyga o wszystkim innym, nie jest jednak w nagłówku:
**273 GB/s przepustowości pamięci**. [Niezależne
pomiary](https://www.lmsys.org/blog/2025-10-13-nvidia-dgx-spark/) zgodnie
wskazują, że to ona, a nie petaflop, wyznacza realną wydajność wnioskowania -
GPT-OSS 120B daje ~38,6 tok/s wobec 124 tok/s na zestawie trzech RTX 3090.
Wybiera się tu „**mieści się**" zamiast „**jest szybkie**".

## Co z tego wynika dla nas - policzone, nie oszacowane na oko

```
$ yarn mercato compute plan

NVIDIA DGX Spark (GB10) (DGX-SPARK-1)
  128 GB · 273 GB/s · 1000 TFLOPS fp4
  role: training, evaluation, simulation, data_processing

Wnioskowanie autoregresyjne:
  VLA 7B, FP16                      14 GB    ~8.8 tok/s
  VLA 7B, INT8                       7 GB    ~17.6 tok/s
  model gęsty 70B, FP8              70 GB    ~1.8 tok/s
  MoE 120B (5B aktywnych), FP4      60 GB    ~48.2 tok/s
  model gęsty 400B, FP8            400 GB    nie mieści się

Wnioskowanie wizyjne (detektor 120 MB, 60 GFLOP/klatkę, 30 kl./s):
  2 strumienie   ~365 kl./s   wystarcza  (ograniczenie: compute)
  16 strumieni    ~46 kl./s   wystarcza  (ograniczenie: compute)
```

Trzy rzeczy warte odczytania z tej tabelki:

1. **Model gęsty 70B mieści się i jest bezużyteczny do sterowania** - 1,8 tok/s.
   „Mieści się" nie znaczy „nadaje się".
2. **Mieszanka ekspertów zmienia wszystko.** 120B z 5B aktywnymi na token czyta
   z pamięci dwudziestokrotnie mniej niż gęsty 120B i dlatego bywa użyteczna
   tam, gdzie gęsty nie jest. Rachunek na parametrach łącznych odrzuciłby
   rozwiązanie, które działa.
3. **Przy wizji wąskie gardło się odwraca.** Detektor o wagach rzędu stu
   megabajtów czyta się w ułamku milisekundy - liczy się moc na klatkę.
   Funkcja, która dla każdego obciążenia odpowiada „ograniczeniem jest pamięć",
   każe kupować nie to, co trzeba.

## Gdzie ta maszyna pasuje

| Rola | Dlaczego |
| --- | --- |
| **trening i dostrajanie** | to jest maszyna do tego zbudowana; zamyka pętlę, którą otwiera moduł `datasets` |
| **ewaluacja** | zestawy z fazy 5 przed dopuszczeniem polityki |
| **symulacja** | sim2real bez wynajmowania chmury |
| **przetwarzanie danych** | przeliczanie archiwum, budowa zbiorów |

## Gdzie NIE pasuje - i to jest ważniejsze

**Nigdy w łańcuchu bezpieczeństwa.** Zatrzymanie maszyny musi być
deterministyczne i **niezależne od polityki**. Współdzielony system ogólnego
przeznaczenia z akceleratorem nie daje ani determinizmu (brak czasu
rzeczywistego, planista, GC, sterowniki), ani niezależności (ten sam układ
liczy politykę). Realizuje to sterownik celi albo obwód bezpieczeństwa.

**Nie jako sterownik czasu rzeczywistego.** Pętle regulacji chodzą na
setkach herców z twardym terminem; DGX OS to Ubuntu, nie system czasu
rzeczywistego.

**Nie jako „serce systemu" w sensie jedynego hosta.** Cały ten projekt stoi na
rozdzieleniu ról: rejestr polityk osobno od wdrożenia, wdrożenie osobno od
bezpieczeństwa, tożsamość agenta osobno od robota. Jedna maszyna, na której
stoi ERP, trening, wnioskowanie i kanał brzegowy, zwija to rozdzielenie
z powrotem w jeden punkt awarii - i to punkt bez redundancji, bez zapasowego
zasilania i bez umowy serwisowej.

Sercem systemu jest **rejestr**, a nie akcelerator. Akcelerator jest
narzędziem, które rejestr przypisuje do zadań.

## Co doszło w kodzie

**Moduł `compute`** - rejestr węzłów ze zdolnościami i przypisaniami. Dwie
tabele, zero orkiestracji: jeśli pojawi się tu pole `job_status`, modelowanie
poszło w stronę, w której ERP udaje Kubernetes.

Trzy rzeczy, które ten rejestr wymusza:

- **Przepustowość pamięci jest polem obowiązkowym.** Rejestr bez niej
  pozwalałby planować obciążenia z nagłówka arkusza danych.
- **Precyzja przy mocy obliczeniowej jest polem obowiązkowym.** Ten sam układ
  ma inną moc w FP4 i FP16, a podstawienie jednej do rachunku dla drugiej
  **odwraca werdykt o wąskim gardle**. Wiem, bo tak się pomyliłem we własnym
  teście i test to złapał.
- **Rola `safety_function` nie istnieje w słowniku** - ani w kodzie, ani
  w ograniczeniu bazy. Nie da się jej wpisać nawet z pominięciem komendy.

**Uszczelnienie `safety`.** Do tej pory `safetyLayer` był wolnym tekstem
sprawdzanym wyłącznie na niepustość. Zdanie *„warstwą bezpieczeństwa jest model
nadzorczy na węźle obliczeniowym"* brzmi poważnie, nie jest warstwą
bezpieczeństwa i przechodziło bez mrugnięcia. Doszło pole `safetyLayerKind`
ze słownikiem zamkniętym: `hardware_estop`, `safety_plc`,
`safety_rated_torque_limit`, `safety_rated_speed_limit`, `light_curtain`,
`fence_interlock`, `dual_channel_relay`.

Wyuczonego modelu nie da się w tym polu **wyrazić** - a to jest mocniejsze niż
odmowa po sprawdzeniu. Kolumna jest `null`-owalna, bo uzasadnienia sprzed
zmiany istnieją i nie wolno ich cicho unieważnić; wymóg działa przy
zatwierdzaniu.

**Domknięcie luki w `datasets`.** `datasets_training_runs` nie zapisywał,
**na czym** odbył się trening. Bez tego „ta sama wersja polityki zachowuje się
inaczej niż miesiąc temu" nie ma gdzie znaleźć wyjaśnienia. Przypisanie
(`compute_placements`) niesie węzeł i wersje narzędzi, jako przedział czasu,
a nie stan bieżący.

## Czego te liczby nie są

Szacunkami z pułapu przepustowości i mocy, ze sprawnością przyjętą na 45%
(pamięć) i 35% (moc). **Nie są pomiarem.** Pierwszy prawdziwy przebieg
treningowy na tym sprzęcie zweryfikuje albo obali te założenia - i wtedy
sprawność wpisuje się jako zmierzoną, nie jako przyjętą.

Decyzja, której nie podjąłem za nikogo: czy to ma być **jedna maszyna na
zakład** (trening i ewaluacja centralnie, wnioskowanie przy celach na czymś
mniejszym), czy **węzeł przy celi**. Rejestr obsługuje oba układy - pole
`cell_id` jest `null`-owalne właśnie dlatego.

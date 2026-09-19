#!/usr/bin/env python3
"""Generator bazy 'legacy' sortowni.

Tworzy plik SQLite ze zbiorem bazowym (historia, ktora "od lat siedzi
w starym systemie") oraz ze zbiorem zapasowym ruchow, ktore ujawniaja sie
stopniowo w czasie dzialania demo.

Przy okazji zaklada poczatkowy zrzut plikowy w katalogu wsad/ (katalogi w CSV,
ksiega ruchow w .xlsx) - bo czesci danych webERP przez XML-RPC nie wystawia
i w prawdziwym wdrozeniu przychodza one z innej bazy albo z excelka.

Uruchomienie:
    python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import random
import sqlite3

try:  # uruchomienie jako modul pakietu (testy)
    from . import spooler
except ImportError:  # uruchomienie jako skrypt
    import spooler  # type: ignore

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = HERE / "schema.sql"

# Ziarno stale: ta sama baza przy kazdym uruchomieniu, zeby demo bylo powtarzalne.
SEED = 20250918

def nip(base9: str) -> str:
    """NIP z poprawna cyfra kontrolna (wagi 6,5,7,2,3,4,5,6,7, modulo 11).

    Dane maja wygladac jak wyciagniete z rejestru, a nie jak losowe cyfry -
    pierwszy ksiegowy, ktory je zobaczy, sprawdzi wlasnie sume kontrolna.
    """
    weights = (6, 5, 7, 2, 3, 4, 5, 6, 7)
    checksum = sum(int(d) * w for d, w in zip(base9, weights)) % 11
    if checksum == 10:
        raise ValueError(f"NIP {base9} nie ma poprawnej cyfry kontrolnej")
    return base9 + str(checksum)


DEBTORS = [
    # debtorno, name, address1, address2 (miasto), debtortype, currcode, clientsince, creditlimit, taxref, bdonumber
    ("D001", "Gmina Wieliszew",              "ul. Modlinska 12",     "Wieliszew",  "DOS", "PLN", "2011-03-14", 0.0, nip("536178001"), "000012456"),
    ("D002", "Spoldzielnia Mieszkaniowa Zorza", "ul. Sloneczna 4",   "Legionowo",  "DOS", "PLN", "2013-09-01", 0.0, nip("536241002"), "000023781"),
    ("D003", "PPHU Transbud",                "ul. Przemyslowa 88",   "Nowy Dwor",  "DOS", "PLN", "2016-06-20", 0.0, nip("536310003"), "000031094"),
    ("D004", "Zaklad Komunalny Serock",      "ul. Nadrzeczna 3",     "Serock",     "DOS", "PLN", "2009-01-08", 0.0, nip("536422004"), "000047215"),
    ("D005", "RecycleHub Sp. z o.o.",        "ul. Fabryczna 21",     "Ostroleka",  "ODB", "PLN", "2012-04-02", 250000.0, nip("774113005"), "000118340"),
    ("D006", "PlastMet Sp. z o.o.",          "ul. Tworzywowa 7",     "Plock",      "ODB", "PLN", "2014-11-17", 180000.0, nip("774250006"), "000126702"),
    ("D007", "Huta Szkla Jaroslaw",          "ul. Hutnicza 1",       "Jaroslaw",   "ODB", "EUR", "2018-02-05", 120000.0, nip("795104007"), "000139518"),
    ("D008", "Cementownia Odolanow RDF",     "ul. Wapienna 40",      "Odolanow",   "ODB", "PLN", "2019-08-22", 300000.0, nip("622187008"), "000145063"),
]

STOCKS = [
    # stockid, description, categoryid, units, actualcost (PLN/kg), decimalplaces, recoverycode
    #
    # Kody procesu odzysku wg zalacznika do ustawy o odpadach (transpozycja
    # zalacznika II dyrektywy 2008/98/WE): R1 - wykorzystanie jako paliwo,
    # R3 - recykling substancji organicznych, R4 - recykling metali,
    # R5 - recykling innych materialow nieorganicznych.
    ("20 01 01", "Papier i tektura",            "SUR", "kg", 0.32, 2, "R3"),
    ("15 01 02", "Tworzywa sztuczne PET",       "SUR", "kg", 1.15, 2, "R3"),
    ("20 01 02", "Szklo opakowaniowe",          "SUR", "kg", 0.08, 2, "R5"),
    ("20 01 40", "Metale (zlom mieszany)",      "SUR", "kg", 1.85, 2, "R4"),
    ("19 12 10", "RDF - paliwo alternatywne",   "PAL", "kg", 0.05, 2, "R1"),
    ("20 02 01", "Odpady ulegajace biodegradacji", "BIO", "kg", 0.02, 2, "R3"),
]

LOCATIONS = [
    ("PRZYJ", "Plac przyjec",       "ul. Skladowa 2, Wieliszew"),
    ("BOKS1", "Boks 1 - papier",    "ul. Skladowa 2, Wieliszew"),
    ("BOKS2", "Boks 2 - tworzywa",  "ul. Skladowa 2, Wieliszew"),
    ("BOKS3", "Boks 3 - szklo",     "ul. Skladowa 2, Wieliszew"),
    ("BOKS4", "Boks 4 - metale",    "ul. Skladowa 2, Wieliszew"),
    ("MAGRDF", "Magazyn RDF",       "ul. Skladowa 6, Wieliszew"),
]

# Do ktorego boksu trafia wysortowana frakcja i z ktorego jest wydawana.
FRACTION_LOC = {
    "20 01 01": "BOKS1",
    "15 01 02": "BOKS2",
    "20 01 02": "BOKS3",
    "20 01 40": "BOKS4",
    "19 12 10": "MAGRDF",
    "20 02 01": "PRZYJ",
}

# Ktory odbiorca bierze ktora frakcje.
FRACTION_BUYER = {
    "20 01 01": "D005",
    "15 01 02": "D006",
    "20 01 02": "D007",
    "20 01 40": "D006",
    "19 12 10": "D008",
    "20 02 01": "D008",
}

SUPPLIERS = [d[0] for d in DEBTORS if d[4] == "DOS"]
COST = {s[0]: s[4] for s in STOCKS}

# Frakcje, ktore przechodza przez sortowanie. Bioodpady jada wprost z placu
# przyjec do kompostowni, wiec nie maja wlasnego boksu i nie maja ruchu SORT.
SORTED_FRACTIONS = [s for s in FRACTION_LOC if FRACTION_LOC[s] != "PRZYJ"]

RECEIVING = "PRZYJ"


class Ledger:
    """Saldo magazynu prowadzone w trakcie generowania.

    Bez tego generator wypuszczal wiecej, niz przyjal, i stany schodzily
    ponizej zera - w sortowni to niemozliwe, a na ekranie wyglada jak blad
    integracji, nie jak dane.
    """

    def __init__(self) -> None:
        self.balance: dict[tuple[str, str], float] = {}

    def get(self, stockid: str, loccode: str) -> float:
        return self.balance.get((stockid, loccode), 0.0)

    def add(self, stockid: str, loccode: str, qty: float) -> None:
        key = (stockid, loccode)
        self.balance[key] = round(self.balance.get(key, 0.0) + qty, 2)


def iso(moment: dt.datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


def make_event(rng: random.Random, ledger: Ledger, when: dt.datetime, next_no: int) -> list:
    """Jedno zdarzenie magazynowe: zero, jeden albo dwa wiersze ksiegi.

    PZ dokłada na plac przyjec, SORT przenosi z placu do boksu (dwa wiersze,
    jak przesuniecie miedzymagazynowe), WZ zdejmuje z boksu. Kazdy ruch bierze
    tylko tyle, ile naprawde lezy - brak towaru oznacza, ze zdarzenie nie
    dochodzi do skutku.
    """
    roll = rng.random()

    if roll < 0.34:                                    # PZ - przyjecie odpadu
        stockid = rng.choice(list(FRACTION_LOC))
        qty = round(rng.uniform(800, 9000), 2)
        ledger.add(stockid, RECEIVING, qty)
        return [(next_no, stockid, "PZ", RECEIVING, iso(when), rng.choice(SUPPLIERS), qty, COST[stockid])]

    if roll < 0.78:                                    # SORT - wysortowanie frakcji
        stockid = rng.choice(SORTED_FRACTIONS)
        available = ledger.get(stockid, RECEIVING)
        if available < 300:
            return []
        qty = round(min(available, rng.uniform(1200, 7000)), 2)
        loccode = FRACTION_LOC[stockid]
        ledger.add(stockid, RECEIVING, -qty)
        ledger.add(stockid, loccode, qty)
        return [
            (next_no, stockid, "SORT", RECEIVING, iso(when), None, -qty, COST[stockid]),
            (next_no + 1, stockid, "SORT", loccode, iso(when), None, qty, COST[stockid]),
        ]

    stockid = rng.choice(list(FRACTION_BUYER))         # WZ - wydanie do odbiorcy
    loccode = FRACTION_LOC[stockid]
    available = ledger.get(stockid, loccode)
    if available < 500:
        return []
    qty = round(min(available, rng.uniform(500, 12000)), 2)
    ledger.add(stockid, loccode, -qty)
    return [(next_no, stockid, "WZ", loccode, iso(when), FRACTION_BUYER[stockid], -qty, COST[stockid])]


def make_base_moves(rng: random.Random, ledger: Ledger, now: dt.datetime, count: int, start_no: int):
    """Zbior bazowy: co najmniej `count` wierszy ksiegi z ostatnich 30 dni.

    Zdarzenia ida chronologicznie, bo saldo magazynu musi sie zgadzac w kazdej
    chwili. Kilka pierwszych prob sortowania i wydania spala na panewce
    (magazyn jest jeszcze pusty) - dokladnie tak, jak w prawdziwej ksiedze.
    """
    stamps = sorted(now - dt.timedelta(days=rng.uniform(0.5, 30.0)) for _ in range(count))
    moves = []
    for when in stamps:
        moves.extend(make_event(rng, ledger, when, start_no + len(moves)))
    return moves


def make_reserve_moves(rng: random.Random, ledger: Ledger, now: dt.datetime, count: int,
                       start_no: int, step_seconds: int):
    """Zbior zapasowy: ruchy ze znacznikami czasu w przyszlosci.

    Startuje od salda, ktore zostawil zbior bazowy, wiec magazyn nie schodzi
    ponizej zera takze po ujawnieniu tych ruchow. Spooler zrzuca do wsad/
    tylko te, ktorych trandate juz minela, wiec plik rosnie w czasie
    - to daje efekt zywej synchronizacji przyrostowej.
    """
    moves = []
    tick = 0
    while len(moves) < count:
        tick += 1
        when = now + dt.timedelta(seconds=step_seconds * tick)
        moves.extend(make_event(rng, ledger, when, start_no + len(moves)))
    return moves


def attach_sales_orders(moves, start_no: int):
    """Kazde WZ dostaje naglowek zamowienia i wskazuje go kolumna `orderno`.

    W prawdziwym webERP `stockmoves.orderno` wiaze wydanie z zamowieniem i to
    jest jedyny sposob, zeby po stronie odbiorczej odtworzyc, co komu sprzedano.
    Bez tej kolumny zostaje zgadywanie po dacie i ilosci - a tego sie nie robi.

    Zwraca ruchy uzupelnione o `orderno` (NULL dla PZ i SORT) oraz naglowki.
    """
    orders = []
    out_moves = []
    no = start_no
    for move in moves:
        stkmoveno, stockid, typ, loc, trandate, debtorno, qty, cost = move
        if typ != "WZ":
            out_moves.append(move + (None,))
            continue
        orddate = (dt.datetime.fromisoformat(trandate) - dt.timedelta(days=2)).date().isoformat()
        deliverydate = dt.datetime.fromisoformat(trandate).date().isoformat()
        # Cena sprzedazy: koszt frakcji z narzutem handlowym.
        orders.append((no, debtorno, orddate, deliverydate, stockid, abs(qty), round(cost * 1.35, 4)))
        out_moves.append(move + (no,))
        no += 1
    return out_moves, orders


# Stawka VAT uzywana przy wystawianiu naleznosci po stronie legacy.
VAT = 1.23


def make_open_orders(rng: random.Random, now: dt.datetime, start_no: int, count: int):
    """Zamowienia przyjete, ale jeszcze niezrealizowane.

    Kazda sortownia ma takie w kazdej chwili: odbiorca zamowil frakcje, termin
    odbioru jeszcze nie nadszedl, towar ma lezec i czekac. Bez nich rezerwacje
    magazynowe nie mialyby czego pilnowac, a magazynier obiecywalby ten sam
    boks dwom odbiorcom.
    """
    orders = []
    no = start_no
    for _ in range(count):
        stockid = rng.choice(list(FRACTION_BUYER))
        debtorno = FRACTION_BUYER[stockid]
        orddate = (now - dt.timedelta(days=rng.randint(1, 6))).date().isoformat()
        deliverydate = (now + dt.timedelta(days=rng.randint(2, 14))).date().isoformat()
        qty = round(rng.uniform(1500, 9000), 2)
        orders.append((no, debtorno, orddate, deliverydate, stockid, qty,
                       round(COST[stockid] * 1.35, 4)))
        no += 1
    return orders


def make_payments(orders, rng: random.Random, now: dt.datetime, start_no: int):
    """Wplaty odbiorcow: czesc w terminie, czesc czesciowa, czesc wcale.

    Zaplacone wszystko byloby nieprawda o kazdej sortowni, jaka istnieje.
    Rozklad jest celowo niewygodny, zeby pulpit mial co pokazac w naleznosciach.
    """
    payments = []
    no = start_no
    for orderno, debtorno, _orddate, deliverydate, _stockid, qty, unitprice in orders:
        brutto = round(qty * unitprice * VAT, 2)
        roll = rng.random()
        if roll < 0.15:
            continue                                   # nie zaplacil wcale
        delivered = dt.datetime.fromisoformat(deliverydate)
        paid_on = delivered + dt.timedelta(days=rng.randint(3, 45))
        if paid_on > now:
            continue                                   # termin jeszcze nie minal
        amount = round(brutto * 0.5, 2) if roll < 0.25 else brutto   # czesciowa
        payments.append((no, debtorno, orderno, paid_on.date().isoformat(), "ZAPL", amount))
        no += 1
    return payments


def build(db_path: pathlib.Path, base_moves_count: int, reserve_moves_count: int, reserve_step: int,
          wsad_dir: pathlib.Path | None = None) -> None:
    rng = random.Random(SEED)
    now = dt.datetime.now().replace(microsecond=0)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))

    conn.executemany("INSERT INTO debtorsmaster VALUES (?,?,?,?,?,?,?,?,?,?)", DEBTORS)
    conn.executemany("INSERT INTO stockmaster VALUES (?,?,?,?,?,?,?)", STOCKS)
    conn.executemany("INSERT INTO locations VALUES (?,?,?)", LOCATIONS)

    ledger = Ledger()
    base_moves = make_base_moves(rng, ledger, now, base_moves_count, start_no=100001)
    reserve_moves = make_reserve_moves(
        rng, ledger, now, reserve_moves_count, start_no=100001 + len(base_moves),
        step_seconds=reserve_step
    )
    all_moves, sales_orders = attach_sales_orders(base_moves + reserve_moves, start_no=5001)
    conn.executemany("INSERT INTO stockmoves VALUES (?,?,?,?,?,?,?,?,?)", all_moves)

    # Stany magazynowe wynikaja ze zbioru bazowego (ruchy zapasowe jeszcze "nie zaszly").
    balances: dict[tuple[str, str], float] = {}
    for _no, stockid, _type, loccode, _trandate, _debtorno, qty, _cost in base_moves:  # bez orderno
        key = (stockid, loccode)
        balances[key] = round(balances.get(key, 0.0) + qty, 2)
    for (stockid, loccode), qty in balances.items():
        conn.execute("INSERT INTO locstock VALUES (?,?,?)", (stockid, loccode, qty))

    # Zamowienia otwarte numerujemy za zrealizowanymi, zeby numeracja rosla.
    open_orders = make_open_orders(rng, now, start_no=5001 + len(sales_orders), count=6)
    sales_orders = sales_orders + open_orders
    conn.executemany("INSERT INTO salesorders VALUES (?,?,?,?,?,?,?)", sales_orders)
    # Wplaty dotycza wylacznie wydan, ktore juz zaszly.
    payments = make_payments([o for o in sales_orders if o not in open_orders], rng, now, start_no=9001)
    conn.executemany("INSERT INTO debtortrans VALUES (?,?,?,?,?,?)", payments)

    conn.commit()
    counts = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("debtorsmaster", "stockmaster", "locations", "locstock", "stockmoves",
                      "salesorders", "debtortrans")
    }
    conn.close()

    print(f"Baza: {db_path}")
    for table, n in counts.items():
        print(f"  {table:<14} {n}")
    print(f"  w tym ruchy zapasowe: {len(reserve_moves)} (co {reserve_step} s od teraz)")

    if wsad_dir is not None:
        spooler.export_catalogs(db_path, wsad_dir)
        exported = spooler.export_moves(db_path, wsad_dir)
        print(f"Zrzut plikowy: {wsad_dir} (ruchy w excelku: {exported})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generator bazy legacy sortowni")
    parser.add_argument("--db", default=str(HERE / "sortownia.db"), help="sciezka pliku SQLite")
    parser.add_argument("--base-moves", type=int, default=200, help="liczba ruchow zbioru bazowego")
    parser.add_argument("--reserve-moves", type=int, default=60, help="liczba ruchow zbioru zapasowego")
    parser.add_argument("--reserve-step", type=int, default=20,
                        help="co ile sekund ujawnia sie kolejny ruch zapasowy")
    parser.add_argument("--wsad", default=str(HERE / "wsad"),
                        help="katalog zrzutu plikowego (katalogi CSV + ksiega ruchow .xlsx)")
    args = parser.parse_args()
    build(pathlib.Path(args.db), args.base_moves, args.reserve_moves, args.reserve_step,
          pathlib.Path(args.wsad))


if __name__ == "__main__":
    main()

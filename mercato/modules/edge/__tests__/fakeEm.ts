/**
 * Minimalny magazyn w pamięci udający `EntityManager`.
 *
 * Jedna rzecz jest tu odwzorowana celowo wiernie: **identyfikator powstaje
 * dopiero przy zrzucie**, tak jak w Postgresie z `gen_random_uuid()`. Gdyby
 * atrapa nadawała `id` od razu, testy przechodziłyby również dla kodu, który
 * czyta `id` przed `flush()` - a to jest dokładnie ten błąd, który wywrócił
 * pierwszą wersję rejestracji robota.
 */

type Row = Record<string, unknown>

let counter = 0
function nextId(): string {
  counter += 1
  const hex = counter.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected === null) return actual === null || actual === undefined
    return actual === expected
  })
}

export type FakeEm = {
  store: Map<string, Row[]>
  rows: (entity: unknown) => Row[]
  fork: () => FakeEm
  findOne: (entity: unknown, where: Row) => Promise<Row | null>
  find: (entity: unknown, where: Row) => Promise<Row[]>
  create: (entity: unknown, data: Row) => Row
  persist: (row: Row) => void
  nativeUpdate: (entity: unknown, where: Row, data: Row) => Promise<number>
  flush: () => Promise<void>
}

function nameOf(entity: unknown): string {
  return (entity as { name?: string })?.name ?? String(entity)
}

export function createFakeEm(seed: Record<string, Row[]> = {}): FakeEm {
  const store = new Map<string, Row[]>(Object.entries(seed))
  const pending: Array<{ table: string; row: Row }> = []

  const em: FakeEm = {
    store,
    rows: (entity) => store.get(nameOf(entity)) ?? [],
    fork: () => em,
    async findOne(entity, where) {
      return (store.get(nameOf(entity)) ?? []).find((row) => matches(row, where)) ?? null
    },
    async find(entity, where) {
      return (store.get(nameOf(entity)) ?? []).filter((row) => matches(row, where))
    },
    create(entity, data) {
      /**
       * Tworzymy prawdziwą instancję klasy encji, a nie obiekt-literał.
       *
       * To nie jest szczegół: inicjalizatory pól (`activeFrom = new Date()`,
       * `status = 'enrolled'`) są w tych encjach realnym źródłem wartości
       * domyślnych i MikroORM je stosuje. Atrapa rozdająca same przekazane
       * pola przepuszczałaby kod, który w produkcji dostaje `undefined`.
       */
      const instance = new (entity as new () => Row)()
      Object.assign(instance, data)
      ;(instance as Row).__table = nameOf(entity)
      // `id` nadaje dopiero zrzut, jak baza.
      delete (instance as Row).id
      return instance
    },
    persist(row) {
      pending.push({ table: String(row.__table ?? 'unknown'), row })
    },
    async nativeUpdate(entity, where, data) {
      const rows = (store.get(nameOf(entity)) ?? []).filter((row) => matches(row, where))
      for (const row of rows) Object.assign(row, data)
      return rows.length
    },
    async flush() {
      while (pending.length) {
        const entry = pending.shift()!
        if (!entry.row.id) entry.row.id = nextId()
        const list = store.get(entry.table) ?? []
        if (!list.includes(entry.row)) list.push(entry.row)
        store.set(entry.table, list)
      }
    },
  }

  return em
}

export function makeCtx(em: FakeEm, sub: string | null = 'user-1') {
  return {
    container: { resolve: () => em },
    auth: sub ? { sub } : null,
  } as never
}

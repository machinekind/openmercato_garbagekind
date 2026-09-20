/**
 * Kalibracja jako warunek dopuszczenia, nie jako zadanie serwisowe.
 *
 * Reguła jest jedna i twarda: robot, któremu wygasł choć jeden wymagany
 * pomiar, nie jest dopuszczony - nawet gdy mechanicznie jest bez zarzutu
 * i właśnie wyjechał z przeglądu. To rozróżnienie jest tym, co odróżnia
 * platformę operacyjną od systemu utrzymania ruchu.
 *
 * Czysta funkcja bez bazy, bo to ona rozstrzyga o ruchu maszyny.
 */

export type CalibrationRecord = {
  kind: string
  measuredAt: Date
  validUntil: Date
  invalidatedAt?: Date | null
}

export type CalibrationStatus = {
  kind: string
  state: 'valid' | 'expired' | 'invalidated' | 'missing'
  validUntil?: Date
  /** Ile dni zostało; ujemne, gdy pomiar już wygasł. `null`, gdy brak pomiaru. */
  daysLeft: number | null
}

export type CalibrationVerdict = {
  /** Czy komplet wymaganych pomiarów jest ważny w podanej chwili. */
  complete: boolean
  statuses: CalibrationStatus[]
  /** Rodzaje, które blokują dopuszczenie - puste, gdy `complete`. */
  blocking: string[]
  /** Czytelny powód odmowy, gotowy do wpisania w `state_reason`. */
  reason?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

/**
 * Najnowszy nieunieważniony pomiar danego rodzaju.
 *
 * Bierzemy najnowszy po `measuredAt`, a nie ten o najdalszej dacie ważności:
 * rekalibracja po uderzeniu w robota bywa *krótsza* niż poprzednia, a mimo to
 * jest tą obowiązującą. Sortowanie po ważności przemyciłoby stary pomiar.
 */
function latestByKind(records: CalibrationRecord[], kind: string): CalibrationRecord | null {
  let best: CalibrationRecord | null = null
  for (const record of records) {
    if (record.kind !== kind) continue
    if (record.invalidatedAt) continue
    if (!best || record.measuredAt.getTime() > best.measuredAt.getTime()) best = record
  }
  return best
}

export function evaluateCalibration(
  required: string[],
  records: CalibrationRecord[],
  now: Date = new Date(),
): CalibrationVerdict {
  const statuses: CalibrationStatus[] = []
  const blocking: string[] = []

  for (const kind of required) {
    const latest = latestByKind(records, kind)

    if (!latest) {
      // Rozróżniamy brak pomiaru od pomiaru unieważnionego: pierwsze znaczy
      // „nigdy nie zrobiono", drugie „zrobiono i ktoś świadomie odwołał".
      const wasInvalidated = records.some((r) => r.kind === kind && r.invalidatedAt)
      statuses.push({ kind, state: wasInvalidated ? 'invalidated' : 'missing', daysLeft: null })
      blocking.push(kind)
      continue
    }

    const left = daysBetween(now, latest.validUntil)
    const expired = latest.validUntil.getTime() <= now.getTime()
    statuses.push({
      kind,
      state: expired ? 'expired' : 'valid',
      validUntil: latest.validUntil,
      daysLeft: left,
    })
    if (expired) blocking.push(kind)
  }

  if (!blocking.length) return { complete: true, statuses, blocking: [] }

  return {
    complete: false,
    statuses,
    blocking,
    reason: `brak ważnej kalibracji: ${blocking.join(', ')}`,
  }
}

/**
 * Pomiary, które wygasną w zadanym oknie - podstawa wyprzedzającego alertu.
 *
 * Bez tego jedyną informacją o kalibracji jest moment, w którym robot już
 * stanął. Planista serwisu potrzebuje jej tydzień wcześniej.
 */
export function expiringWithin(
  verdict: CalibrationVerdict,
  days: number,
): CalibrationStatus[] {
  return verdict.statuses.filter(
    (status) => status.state === 'valid' && status.daysLeft !== null && status.daysLeft <= days,
  )
}

/**
 * Żywotność agenta jako funkcja czasu, nie jako flaga w bazie.
 *
 * To jest jedna decyzja projektowa i warto ją nazwać wprost. Kusząca
 * alternatywa - kolumna `online boolean` ustawiana przy odbiorze heartbeatu
 * i gaszona przez zadanie cykliczne - psuje się w dokładnie tym momencie,
 * w którym ma zadziałać: gdy proces gaszący padnie, cała flota zostaje
 * na ekranie jako „online", w tym maszyny odłączone od prądu. Pulpit
 * kłamie wtedy najgłośniej wtedy, kiedy najbardziej trzeba mu wierzyć.
 *
 * Stan wyprowadzony z `last_seen_at` nie ma tej awarii: brak zapisu też jest
 * informacją, bo cisza sama upływa.
 */

export type LivenessState = 'never_seen' | 'online' | 'late' | 'lost'

export type LivenessInput = {
  lastSeenAt: Date | null | undefined
  heartbeatIntervalSeconds: number
  livenessGraceSeconds: number
  lostAfterSeconds: number
  status?: 'enrolled' | 'revoked'
}

export type LivenessVerdict = {
  state: LivenessState
  /** Sekundy od ostatniego uderzenia serca; `null`, gdy agent nigdy się nie odezwał. */
  silenceSeconds: number | null
  /** Do kiedy cisza jest jeszcze normalna. */
  deadline: Date | null
  /** Ile sekund zostało do przekroczenia terminu; ujemne znaczy „po terminie". */
  secondsToDeadline: number | null
  reason: string
}

/**
 * Termin kolejnego uderzenia serca.
 *
 * Odstęp plus tolerancja, nie sam odstęp: pakiet wysłany co do sekundy
 * i tak dociera z opóźnieniem, a alarm o jedną zgubioną ramkę jest alarmem,
 * którego po tygodniu nikt już nie czyta.
 */
export function heartbeatDeadline(lastSeenAt: Date, input: Pick<LivenessInput, 'heartbeatIntervalSeconds' | 'livenessGraceSeconds'>): Date {
  const window = Math.max(1, input.heartbeatIntervalSeconds) + Math.max(0, input.livenessGraceSeconds)
  return new Date(lastSeenAt.getTime() + window * 1000)
}

export function evaluateLiveness(input: LivenessInput, now: Date = new Date()): LivenessVerdict {
  if (input.status === 'revoked') {
    // Odwołany agent nie jest „offline" - on nie ma prawa być online.
    // Mieszanie tych dwóch rzeczy w jednym polu ukrywa odwołania w szumie awarii.
    return {
      state: 'lost',
      silenceSeconds: null,
      deadline: null,
      secondsToDeadline: null,
      reason: 'Agent odwołany - tożsamość unieważniona.',
    }
  }

  if (!input.lastSeenAt) {
    return {
      state: 'never_seen',
      silenceSeconds: null,
      deadline: null,
      secondsToDeadline: null,
      reason: 'Agent zapisany, ale nigdy się nie odezwał.',
    }
  }

  const silenceSeconds = Math.floor((now.getTime() - input.lastSeenAt.getTime()) / 1000)
  const deadline = heartbeatDeadline(input.lastSeenAt, input)
  const secondsToDeadline = Math.floor((deadline.getTime() - now.getTime()) / 1000)

  if (secondsToDeadline >= 0) {
    return { state: 'online', silenceSeconds, deadline, secondsToDeadline, reason: 'Łączność w normie.' }
  }

  if (silenceSeconds < Math.max(1, input.lostAfterSeconds)) {
    // Spóźnienie to najczęściej sieć. Nie jest powodem do zatrzymania
    // produkcji, ale jest powodem, żeby przestać ufać temu, co pokazuje pulpit.
    return {
      state: 'late',
      silenceSeconds,
      deadline,
      secondsToDeadline,
      reason: `Brak uderzenia serca od ${silenceSeconds} s - termin minął ${-secondsToDeadline} s temu.`,
    }
  }

  return {
    state: 'lost',
    silenceSeconds,
    deadline,
    secondsToDeadline,
    reason: `Cisza od ${silenceSeconds} s - agent uznany za utraconego.`,
  }
}

/** Czy stan oznacza, że centrala nie ma prawa twierdzić, co robot teraz robi. */
export function isUnreliable(state: LivenessState): boolean {
  return state !== 'online'
}

/**
 * Dopuszczalny rozjazd zegarów przy weryfikacji podpisanego znacznika czasu.
 *
 * Dwie minuty to kompromis: NTP na hali potrafi się rozjechać o kilkadziesiąt
 * sekund po restarcie sterownika, a okno powtórki dłuższe niż kilka minut
 * przestaje cokolwiek chronić.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120

export function isTimestampFresh(timestamp: Date, now: Date = new Date()): boolean {
  const delta = Math.abs(now.getTime() - timestamp.getTime()) / 1000
  return delta <= CLOCK_SKEW_TOLERANCE_SECONDS
}

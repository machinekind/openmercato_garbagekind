import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  evaluateLiveness,
  heartbeatDeadline,
  isTimestampFresh,
  isUnreliable,
} from '../lib/liveness'

/**
 * Sedno fazy 0 sprowadza się do jednego zdania: po odcięciu zasilania robot
 * ma zniknąć z pulpitu w zdefiniowanym czasie. Te testy pilnują, żeby
 * „zdefiniowany czas" był naprawdę zdefiniowany, a nie zależny od tego, czy
 * jakiś proces w tle akurat żyje.
 */

const PARAMS = {
  heartbeatIntervalSeconds: 30,
  livenessGraceSeconds: 30,
  lostAfterSeconds: 300,
  status: 'enrolled' as const,
}

const T0 = new Date('2026-09-19T10:00:00Z')

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

describe('evaluateLiveness', () => {
  it('agent, który nigdy się nie odezwał, nie jest ani online, ani utracony', () => {
    const verdict = evaluateLiveness({ ...PARAMS, lastSeenAt: null }, T0)
    expect(verdict.state).toBe('never_seen')
    // Brak terminu jest tu poprawny: nie ma od czego liczyć.
    expect(verdict.deadline).toBeNull()
  })

  it('w oknie odstępu z tolerancją agent jest online', () => {
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(59)).state).toBe('online')
  })

  it('tolerancja jest domknięta: dokładnie na terminie jeszcze online', () => {
    // Granica jest zapisana wprost, bo to jedyne miejsce, w którym „o sekundę
    // za późno" zmienia treść pulpitu.
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(60)).state).toBe('online')
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(61)).state).toBe('late')
  })

  it('spóźnienie i utrata to dwa różne stany, nie stopnie tego samego', () => {
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(120)).state).toBe('late')
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(299)).state).toBe('late')
    expect(evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(300)).state).toBe('lost')
  })

  it('ODCIĘCIE ZASILANIA: robot znika z pulpitu w progu wyliczonym, nie zapisanym', () => {
    // Nikt nic nie zapisywał między T0 a tym wywołaniem - cisza sama upłynęła.
    const verdict = evaluateLiveness({ ...PARAMS, lastSeenAt: T0 }, at(3600))
    expect(verdict.state).toBe('lost')
    expect(verdict.silenceSeconds).toBe(3600)
  })

  it('agent odwołany nie jest „offline" - nie ma prawa być online', () => {
    const verdict = evaluateLiveness({ ...PARAMS, lastSeenAt: at(0), status: 'revoked' }, at(1))
    expect(verdict.state).toBe('lost')
    expect(verdict.reason).toMatch(/odwołany/)
  })

  it('krótsze progi celi dzielonej skracają okno milczenia', () => {
    const shared = { heartbeatIntervalSeconds: 2, livenessGraceSeconds: 1, lostAfterSeconds: 10, status: 'enrolled' as const }
    expect(evaluateLiveness({ ...shared, lastSeenAt: T0 }, at(3)).state).toBe('online')
    expect(evaluateLiveness({ ...shared, lastSeenAt: T0 }, at(4)).state).toBe('late')
    expect(evaluateLiveness({ ...shared, lastSeenAt: T0 }, at(10)).state).toBe('lost')
  })
})

describe('heartbeatDeadline', () => {
  it('termin to odstęp powiększony o tolerancję', () => {
    expect(heartbeatDeadline(T0, PARAMS).toISOString()).toBe(at(60).toISOString())
  })

  it('zerowy odstęp nie daje terminu w przeszłości', () => {
    const deadline = heartbeatDeadline(T0, { heartbeatIntervalSeconds: 0, livenessGraceSeconds: 0 })
    expect(deadline.getTime()).toBeGreaterThan(T0.getTime())
  })
})

describe('isUnreliable', () => {
  it('wszystko poza łącznością znaczy, że centrala nie wie, co robot robi', () => {
    expect(isUnreliable('online')).toBe(false)
    for (const state of ['late', 'lost', 'never_seen'] as const) {
      expect(isUnreliable(state)).toBe(true)
    }
  })
})

describe('isTimestampFresh', () => {
  it('przyjmuje rozjazd zegarów w obie strony', () => {
    expect(isTimestampFresh(at(CLOCK_SKEW_TOLERANCE_SECONDS - 1), T0)).toBe(true)
    expect(isTimestampFresh(at(-(CLOCK_SKEW_TOLERANCE_SECONDS - 1)), T0)).toBe(true)
  })

  it('odrzuca znacznik spoza okna - także z przyszłości', () => {
    expect(isTimestampFresh(at(CLOCK_SKEW_TOLERANCE_SECONDS + 1), T0)).toBe(false)
    expect(isTimestampFresh(at(-(CLOCK_SKEW_TOLERANCE_SECONDS + 1)), T0)).toBe(false)
  })
})

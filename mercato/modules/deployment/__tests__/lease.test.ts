import {
  LEASE_SECONDS,
  evaluateAuthorization,
  leaseSecondsFor,
  reconcile,
  renewAfterSeconds,
} from '../lib/lease'

/**
 * To jest test najważniejszej funkcji w całym projekcie: tej, która rozstrzyga,
 * czy ton metalu wolno się ruszyć bez potwierdzenia z centrali.
 *
 * Dlatego nie wystarczy tu „zwraca false po wygaśnięciu". Sprawdzamy asymetrię
 * klas ryzyka, kierunek domyślności przy nieznanej klasie i to, że odpowiedź
 * zależy **wyłącznie** od zegara i jednej liczby - bez bazy i bez sieci.
 */

const T0 = new Date('2026-09-19T12:00:00.000Z')

function at(secondsFromT0: number): Date {
  return new Date(T0.getTime() + secondsFromT0 * 1000)
}

describe('LEASE_SECONDS - asymetria klas ryzyka', () => {
  it('cela ogrodzona liczona w dniach', () => {
    expect(LEASE_SECONDS.fenced).toBeGreaterThanOrEqual(24 * 60 * 60)
  })

  it('przestrzeń dzielona liczona w godzinach, nie w dniach', () => {
    expect(LEASE_SECONDS.shared).toBeGreaterThanOrEqual(60 * 60)
    expect(LEASE_SECONDS.shared).toBeLessThan(24 * 60 * 60)
  })

  it('przestrzeń publiczna liczona w minutach, nie w godzinach', () => {
    expect(LEASE_SECONDS.public).toBeLessThan(60 * 60)
    expect(LEASE_SECONDS.public).toBeGreaterThanOrEqual(60)
  })

  it('kolejność jest ścisła: ogrodzona > dzielona > publiczna', () => {
    // Gdyby kiedykolwiek przestała być ścisła, cała teza fazy przestaje działać.
    expect(LEASE_SECONDS.fenced).toBeGreaterThan(LEASE_SECONDS.shared)
    expect(LEASE_SECONDS.shared).toBeGreaterThan(LEASE_SECONDS.public)
  })
})

describe('leaseSecondsFor', () => {
  it('zwraca długość dla znanej klasy', () => {
    expect(leaseSecondsFor('fenced')).toBe(LEASE_SECONDS.fenced)
    expect(leaseSecondsFor('public')).toBe(LEASE_SECONDS.public)
  })

  it('nieznana klasa dostaje NAJKRÓTSZĄ dzierżawę', () => {
    // Kierunek domyślności jest tu całą treścią: literówka w konfiguracji celi
    // ma powodować nadmiarowe zatrzymania, a nie ciche przedłużenie pracy.
    expect(leaseSecondsFor('cokolwiek')).toBe(LEASE_SECONDS.public)
    expect(leaseSecondsFor('')).toBe(LEASE_SECONDS.public)
  })
})

describe('evaluateAuthorization - dowód fazy jako czysta funkcja', () => {
  it('po tej samej ciszy robot w celi publicznej stoi, a w ogrodzonej pracuje', () => {
    const cisza = 150 // sekund; więcej niż dzierżawa publiczna, dużo mniej niż ogrodzona
    const publiczna = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(LEASE_SECONDS.public) },
      now: at(cisza),
    })
    const ogrodzona = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(LEASE_SECONDS.fenced) },
      now: at(cisza),
    })

    expect(publiczna.working).toBe(false)
    expect(publiczna.reason).toContain('bez udziału centrali')
    expect(ogrodzona.working).toBe(true)
  })

  it('pracuje do ostatniej sekundy mandatu', () => {
    const tuzPrzed = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(120) },
      now: at(119),
    })
    expect(tuzPrzed.working).toBe(true)
    expect(tuzPrzed.secondsLeft).toBe(1)
  })

  it('w chwili wygaśnięcia już nie pracuje', () => {
    // Granica jest domknięta w stronę zatrzymania, nie pracy.
    const dokladnie = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(120) },
      now: at(120),
    })
    expect(dokladnie.working).toBe(false)
  })

  it('podaje, o ile mandat się spóźnił', () => {
    const po = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(120) },
      now: at(200),
    })
    expect(po.secondsLeft).toBe(-80)
    expect(po.reason).toContain('80 s temu')
  })

  it('brak dzierżawy to nie to samo, co dzierżawa wygasła', () => {
    const brak = evaluateAuthorization({ desiredState: 'running', lease: null, now: T0 })
    expect(brak.working).toBe(false)
    expect(brak.reason).toContain('nigdy nie dostał mandatu')
    expect(brak.secondsLeft).toBeNull()
  })

  it('polecenie „stój" wygrywa ze świeżą dzierżawą', () => {
    // Kolejność pytań: najpierw czy ktokolwiek chce, żeby pracował. Odwrócenie
    // kazałoby robotowi ze świeżym mandatem raportować, że stoi z powodu dzierżawy.
    const auth = evaluateAuthorization({
      desiredState: 'stopped',
      lease: { expiresAt: at(LEASE_SECONDS.fenced) },
      now: T0,
    })
    expect(auth.working).toBe(false)
    expect(auth.reason).toContain('zatrzymany')
  })

  it('odwołana dzierżawa nie działa, choćby termin jeszcze nie minął', () => {
    const auth = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(LEASE_SECONDS.fenced), revokedAt: at(10) },
      now: at(20),
    })
    expect(auth.working).toBe(false)
    expect(auth.reason).toContain('odwołana')
  })

  it('odwołanie z przyszłą datą jeszcze nie działa', () => {
    const auth = evaluateAuthorization({
      desiredState: 'running',
      lease: { expiresAt: at(LEASE_SECONDS.fenced), revokedAt: at(100) },
      now: at(20),
    })
    expect(auth.working).toBe(true)
  })
})

describe('renewAfterSeconds', () => {
  it('daje agentowi co najmniej dwie szanse na ponowienie', () => {
    const lease = LEASE_SECONDS.public
    const renew = renewAfterSeconds(lease)
    expect(renew).toBeLessThanOrEqual(Math.floor(lease / 3))
    // Dwie kolejne próby muszą się zmieścić przed wygaśnięciem.
    expect(renew * 3).toBeLessThanOrEqual(lease)
  })

  it('nigdy nie zwraca zera', () => {
    expect(renewAfterSeconds(1)).toBe(1)
    expect(renewAfterSeconds(0)).toBe(1)
  })
})

describe('reconcile', () => {
  const desired = { desiredPolicyVersionId: 'v-1', desiredState: 'running' as const }

  it('zgodność, gdy robot wykonuje przypisaną wersję', () => {
    expect(
      reconcile({ ...desired, reportedPolicyVersionId: 'v-1', reportedState: 'running' }).state,
    ).toBe('converged')
  })

  it('rozjazd, gdy robot wykonuje inną wersję', () => {
    const verdict = reconcile({ ...desired, reportedPolicyVersionId: 'v-2', reportedState: 'running' })
    expect(verdict.state).toBe('drift')
    expect(verdict.reason).toContain('v-2')
  })

  it('rozjazd, gdy robot stoi mimo polecenia pracy', () => {
    expect(
      reconcile({ ...desired, reportedPolicyVersionId: 'v-1', reportedState: 'stopped' }).state,
    ).toBe('drift')
  })

  it('brak zgłoszenia to osobny stan, a nie zgodność', () => {
    // Zliczanie milczącego robota jako zgodnego jest tym samym błędem,
    // co kolumna `online` gaszona zadaniem cyklicznym.
    const verdict = reconcile({ ...desired, reportedPolicyVersionId: null, reportedState: null })
    expect(verdict.state).toBe('unknown')
  })

  it('przy poleceniu „stój" wersja polityki nie jest porównywana', () => {
    // Robot, który ma stać, nie musi mieć załadowanej żadnej polityki.
    const verdict = reconcile({
      desiredPolicyVersionId: 'v-1',
      desiredState: 'stopped',
      reportedPolicyVersionId: null,
      reportedState: 'stopped',
    })
    expect(verdict.state).toBe('converged')
  })
})

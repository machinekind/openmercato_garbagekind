/**
 * Dzierżawa - odwrotność heartbeatu.
 *
 * Heartbeat mówi **centrali**, że robot żyje. Dzierżawa mówi **robotowi**, jak
 * długo wolno mu pracować bez potwierdzenia z centrali. To rozróżnienie jest
 * całą treścią tej fazy i ma jedną twardą konsekwencję: decyzja o zatrzymaniu
 * zapada lokalnie, na robocie, z zegara i z jednej liczby. Nie wymaga
 * połączenia, nie wymaga zapisu w bazie i nie wymaga niczyjej zgody.
 *
 * Dlatego wszystko poniżej jest czystą funkcją. Gdyby zatrzymanie zależało od
 * zapytania do centrali, odcięcie chmury byłoby awarią bezpieczeństwa w celi
 * publicznej i awarią produkcji w celi ogrodzonej - jednocześnie.
 */

export type RiskClass = 'fenced' | 'shared' | 'public'

export type DesiredState = 'running' | 'stopped'

/**
 * Długość dzierżawy per klasa ryzyka.
 *
 * Liczby są decyzją polityczną udającą techniczną i dlatego stoją tutaj,
 * nazwane, w jednym miejscu, a nie rozsiane po komendach:
 *
 * - `fenced` - cela ogrodzona, ludzie za płotem. Siedem dni: odcięcie chmury
 *   na weekend **nie może** zatrzymać produkcji, bo skutkiem byłoby
 *   wyłączanie bram bezpieczeństwa przez utrzymanie ruchu.
 * - `shared` - przestrzeń dzielona. Osiem godzin, czyli jedna zmiana: robot
 *   przeżywa awarię łącza w trakcie zmiany, ale nie wchodzi na następną bez
 *   potwierdzenia.
 * - `public` - przestrzeń publiczna. Dwie minuty: cisza z centrali jest tu
 *   nieodróżnialna od utraty nadzoru, a koszt fałszywego zatrzymania jest
 *   nieporównywalnie niższy od kosztu fałszywej kontynuacji.
 *
 * Odrzucona alternatywa: jedna długość dla całej floty, konfigurowalna
 * globalnie. Odrzucona, bo każda pojedyncza wartość jest albo zbyt krótka dla
 * celi ogrodzonej, albo zbyt długa dla publicznej - a administrator ustawiający
 * ją raz ustawia ją pod ten przypadek, który akurat boli.
 */
export const LEASE_SECONDS: Record<RiskClass, number> = {
  fenced: 7 * 24 * 60 * 60,
  shared: 8 * 60 * 60,
  public: 120,
}

export function leaseSecondsFor(riskClass: string): number {
  const known = LEASE_SECONDS[riskClass as RiskClass]
  if (known != null) return known
  /**
   * Nieznana klasa ryzyka dostaje najkrótszą dzierżawę, nie najdłuższą.
   *
   * To jedyny bezpieczny kierunek domyślności: literówka w konfiguracji celi
   * ma powodować nadmiarowe zatrzymania, a nie ciche przedłużenie pracy
   * w przestrzeni, o której nic nie wiemy.
   */
  return LEASE_SECONDS.public
}

export type LeaseSnapshot = {
  expiresAt: Date
  revokedAt?: Date | null
}

export type Authorization = {
  /** Czy robot ma w tej chwili prawo wykonywać politykę. */
  working: boolean
  /** Powód, gotowy do wpisania w log robota i w kolumnę pulpitu. */
  reason: string
  /** Ile sekund zostało do wygaśnięcia; ujemne, gdy dzierżawa już wygasła. */
  secondsLeft: number | null
}

/**
 * Jedyna funkcja, którą robot musi umieć policzyć sam.
 *
 * Kolejność pytań niesie sens komunikatu: najpierw czy ktokolwiek chce, żeby
 * pracował, potem czy ma na to ważny mandat. Odwrócenie tej kolejności
 * kazałoby robotowi ze świeżą dzierżawą i poleceniem „stój" raportować,
 * że stoi z powodu dzierżawy.
 */
export function evaluateAuthorization(input: {
  desiredState: DesiredState
  lease: LeaseSnapshot | null
  now?: Date
}): Authorization {
  const now = input.now ?? new Date()

  if (input.desiredState !== 'running') {
    return { working: false, reason: 'stan pożądany to „zatrzymany"', secondsLeft: null }
  }

  if (!input.lease) {
    return {
      working: false,
      reason: 'brak dzierżawy - robot nigdy nie dostał mandatu do pracy',
      secondsLeft: null,
    }
  }

  if (input.lease.revokedAt && input.lease.revokedAt.getTime() <= now.getTime()) {
    return { working: false, reason: 'dzierżawa odwołana przez centralę', secondsLeft: null }
  }

  const secondsLeft = Math.floor((input.lease.expiresAt.getTime() - now.getTime()) / 1000)
  if (secondsLeft <= 0) {
    return {
      working: false,
      reason: `dzierżawa wygasła ${Math.abs(secondsLeft)} s temu - robot zatrzymuje się sam, bez udziału centrali`,
      secondsLeft,
    }
  }

  return { working: true, reason: `dzierżawa ważna jeszcze ${secondsLeft} s`, secondsLeft }
}

/**
 * Kiedy agent powinien poprosić o odnowienie.
 *
 * Jedna trzecia okresu, nie połowa i nie „tuż przed": agent musi zdążyć
 * ponowić próbę co najmniej dwa razy, zanim mandat wygaśnie. Przy dzierżawie
 * dwuminutowej daje to pierwszą próbę po 40 s i dwie kolejne szanse -
 * pojedyncza zgubiona odpowiedź nie zatrzymuje wtedy produkcji.
 */
export function renewAfterSeconds(leaseSeconds: number): number {
  return Math.max(1, Math.floor(leaseSeconds / 3))
}

/**
 * Uzgodnienie stanu faktycznego z pożądanym.
 *
 * Trzeci stan - `unknown` - jest tu obowiązkowy i nie jest wygodą. Robot,
 * który się nie odezwał, nie jest ani zgodny, ani rozjechany; zliczanie go
 * jako zgodnego jest tym samym błędem, co kolumna `online` gaszona zadaniem
 * cyklicznym: pulpit kłamie najgłośniej wtedy, kiedy najbardziej trzeba mu wierzyć.
 */
export type ReconciliationState = 'converged' | 'drift' | 'unknown'

export function reconcile(input: {
  desiredPolicyVersionId: string
  desiredState: DesiredState
  reportedPolicyVersionId?: string | null
  reportedState?: DesiredState | null
}): { state: ReconciliationState; reason: string } {
  if (!input.reportedPolicyVersionId && !input.reportedState) {
    return { state: 'unknown', reason: 'robot nie zgłosił jeszcze stanu faktycznego' }
  }

  if (input.desiredState === 'running' && input.reportedPolicyVersionId !== input.desiredPolicyVersionId) {
    return {
      state: 'drift',
      reason: `robot wykonuje inną wersję polityki niż przypisana (${input.reportedPolicyVersionId ?? 'żadną'})`,
    }
  }

  if (input.reportedState !== input.desiredState) {
    return {
      state: 'drift',
      reason: `stan faktyczny „${input.reportedState}" wobec pożądanego „${input.desiredState}"`,
    }
  }

  return { state: 'converged', reason: 'stan faktyczny zgodny z pożądanym' }
}

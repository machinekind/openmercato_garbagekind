import type { RobotState } from '../data/entities'

/**
 * Cykl życia robota jako czysta funkcja.
 *
 * Wydzielone z komend celowo: to jest jedyne miejsce, które rozstrzyga, czy
 * maszyna w hali może się ruszyć. Taka reguła ma być testowalna bez bazy,
 * bez kontenera i bez szyny komend - inaczej nikt jej nie przetestuje
 * w każdym wariancie, a warianty są tu wszystkim.
 */

/** Przejścia dozwolone w grafie. Czego tu nie ma, tego nie wolno. */
const ALLOWED: Record<RobotState, RobotState[]> = {
  registered: ['commissioning', 'decommissioning'],
  commissioning: ['ready', 'quarantined', 'decommissioning'],
  ready: ['operational', 'maintenance', 'quarantined', 'decommissioning'],
  operational: ['ready', 'maintenance', 'quarantined', 'decommissioning'],
  maintenance: ['ready', 'quarantined', 'decommissioning'],
  quarantined: ['maintenance', 'ready', 'decommissioning'],
  decommissioning: ['decommissioned'],
  // Stan końcowy. Robot wycofany nie wraca - wraca co najwyżej nowy rekord
  // z tym samym numerem seryjnym, i to jest świadoma decyzja człowieka.
  decommissioned: [],
}

/**
 * Przejścia wymagające podpisu człowieka.
 *
 * Reguła doboru: bramkujemy każde przejście, które **dopuszcza** maszynę do
 * pracy albo kończy jej istnienie. Nie bramkujemy przejść, które ją
 * zatrzymują - zatrzymanie ma być tanie, bo inaczej ludzie przestają go używać.
 */
const REQUIRES_APPROVAL = new Set<string>([
  // Dopuszczenie po uruchomieniu: wymaga kompletnej kalibracji i testów odbioru.
  'commissioning->ready',
  // Wyjście z kwarantanny - ZAWSZE. Automatyczne wyjście po ustąpieniu objawu
  // maskuje przyczynę, a przyczyna jest tu jedyną rzeczą, która ma znaczenie.
  'quarantined->ready',
  'quarantined->maintenance',
  // Powrót z serwisu do puli dopuszczonych.
  'maintenance->ready',
  // Wycofanie: tożsamość agenta jest unieważniana trwale.
  'registered->decommissioning',
  'commissioning->decommissioning',
  'ready->decommissioning',
  'operational->decommissioning',
  'maintenance->decommissioning',
  'quarantined->decommissioning',
])

/**
 * Przejścia, które system wykonuje sam, bez pytania.
 *
 * Wszystkie prowadzą do kwarantanny. To jest asymetria wpisana w projekt:
 * zatrzymać wolno automatowi, dopuścić - tylko człowiekowi.
 */
const SYSTEM_MAY_TRIGGER = new Set<string>([
  'ready->quarantined',
  'operational->quarantined',
  'commissioning->quarantined',
  'maintenance->quarantined',
])

export type TransitionActor = 'human' | 'system'

export type TransitionCheck = {
  allowed: boolean
  requiresApproval: boolean
  /** Powód odmowy, gdy `allowed` jest fałszem. Pusty, gdy przejście przechodzi. */
  reason?: string
}

export function transitionKey(from: RobotState, to: RobotState): string {
  return `${from}->${to}`
}

export function isTerminal(state: RobotState): boolean {
  return ALLOWED[state]?.length === 0
}

export function allowedTargets(from: RobotState): RobotState[] {
  return ALLOWED[from] ?? []
}

/**
 * Czy to przejście wolno wykonać temu podmiotowi.
 *
 * Trzy pytania po kolei, bo kolejność odpowiedzi niesie sens komunikatu:
 * czy graf to dopuszcza, czy podmiot ma prawo, czy potrzebny jest podpis.
 */
export function checkTransition(
  from: RobotState,
  to: RobotState,
  actor: TransitionActor,
): TransitionCheck {
  if (from === to) {
    return { allowed: false, requiresApproval: false, reason: `robot jest już w stanie ${to}` }
  }

  const targets = ALLOWED[from]
  if (!targets) {
    return { allowed: false, requiresApproval: false, reason: `nieznany stan wyjściowy: ${from}` }
  }
  if (!targets.includes(to)) {
    const lista = targets.length ? targets.join(', ') : 'żaden - to stan końcowy'
    return {
      allowed: false,
      requiresApproval: false,
      reason: `z ${from} nie da się przejść do ${to}; dozwolone: ${lista}`,
    }
  }

  const key = transitionKey(from, to)

  if (actor === 'system' && !SYSTEM_MAY_TRIGGER.has(key)) {
    return {
      allowed: false,
      requiresApproval: false,
      // Ten komunikat jest treścią projektu, nie uprzejmością: automat, który
      // sam dopuszcza robota do pracy, jest dokładnie tym, czego nie chcemy.
      reason: `przejście ${key} wymaga decyzji człowieka - system może wyłącznie kwarantannować`,
    }
  }

  return { allowed: true, requiresApproval: REQUIRES_APPROVAL.has(key) }
}

/**
 * Czy robot w tym stanie może dostać przypisanie polityki.
 *
 * Używane przez moduł wdrożeń jako bramka wstępna. Trzymane tutaj, bo to
 * własność cyklu życia, a nie wdrożenia - inaczej dwa moduły miałyby dwie
 * wersje tej samej prawdy i w końcu by się rozjechały.
 */
export function mayRunPolicy(state: RobotState): boolean {
  return state === 'operational'
}

/**
 * Czy robot jest widoczny jako „czynny" w zestawieniach floty.
 *
 * Kwarantanna jest tu osobno od serwisu celowo: maszyna w kwarantannie bywa
 * mechanicznie sprawna i stoi w hali, więc zliczanie jej razem z rozebranym
 * robotem zaciemnia obraz dostępności.
 */
export function isActive(state: RobotState): boolean {
  return state === 'ready' || state === 'operational'
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Kanał stanu pożądanego: „ten robot ma uruchomić tę wersję polityki".
 *
 * Trzy rozstrzygnięcia widoczne w każdej tabeli:
 *
 * 1. **Przypisanie i dzierżawa to dwie różne rzeczy.** Przypisanie jest
 *    deklaracją centrali i trwa, dopóki ktoś jej nie zmieni. Dzierżawa jest
 *    mandatem o skończonym terminie, wydawanym robotowi przy każdym kontakcie.
 *    Zlanie ich w jedno pole `expires_at` na przypisaniu zrobiłoby z każdej
 *    zmiany stanu pożądanego zdarzenie o długości zależnej od łącza.
 *
 * 2. **Klasa ryzyka jest kopiowana do przypisania w chwili jego powstania.**
 *    Przestawienie celi z `public` na `fenced` nie może z mocą wsteczną
 *    przedłużyć mandatu, który już działa w hali.
 *
 * 3. **Nic tu nie wie, co polityka robi.** Trzymamy identyfikator wersji
 *    i skrót treści. Treść mieszka w `policy_registry`, tożsamość agenta
 *    w `edge`. Gdyby pojawiło się tu pole z wagami albo z kluczem publicznym,
 *    modelowanie poszłoby złą drogą.
 */

export type DesiredState = 'running' | 'stopped'
export type LeaseExpiryBehavior = 'hold_position' | 'complete_grasp_then_hold' | 'return_home'

/**
 * Deklaracja centrali wobec jednego robota.
 *
 * W danej chwili robot ma **najwyżej jedno** czynne przypisanie. Egzekwuje to
 * indeks częściowy w migracji, a nie pamięć komendy: dwa równoległe wdrożenia
 * przypisujące dwie różne polityki temu samemu ramieniu to nie jest przypadek
 * teoretyczny, tylko normalna kolizja dwóch inżynierów w piątek po południu.
 */
@Entity({ tableName: 'deployment_assignments' })
@Index({ name: 'deployment_assignments_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'deployment_assignments_robot_idx', properties: ['robotId', 'assignedAt'] })
@Index({ name: 'deployment_assignments_version_idx', properties: ['policyVersionId'] })
export class Assignment {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  /** Kopia skrótu treści wersji — robot porównuje ją z tym, co faktycznie załadował. */
  @Property({ name: 'policy_content_digest', type: 'text' })
  policyContentDigest!: string

  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  /**
   * Kopia klasy ryzyka celi z chwili przypisania.
   *
   * Denormalizacja celowa: przestawienie celi nie może z mocą wsteczną
   * przedłużyć mandatu maszyny, która już pracuje. Zmiana klasy ryzyka wymaga
   * nowego przypisania i to jest właściwa cena tej zmiany.
   */
  @Property({ name: 'risk_class', type: 'text' })
  riskClass!: string

  /** Długość dzierżawy wyliczona z klasy ryzyka i zamrożona przy przypisaniu. */
  @Property({ name: 'lease_seconds', type: 'int' })
  leaseSeconds!: number

  /** Kopia kontraktu polityki — agent dostaje ją z każdym odnowieniem mandatu. */
  @Property({ name: 'lease_expiry_behavior', type: 'text' })
  leaseExpiryBehavior!: LeaseExpiryBehavior

  @Property({ name: 'desired_state', type: 'text', default: 'running' })
  desiredState: DesiredState = 'running'

  @Property({ type: 'text' })
  reason!: string

  @Property({ name: 'assigned_by', type: 'uuid', nullable: true })
  assignedBy?: string | null

  @Property({ name: 'assigned_at', type: Date, onCreate: () => new Date() })
  assignedAt: Date = new Date()

  /** Ustawiane, gdy nowe przypisanie zajmuje miejsce tego. Historia zostaje. */
  @Property({ name: 'superseded_at', type: Date, nullable: true })
  supersededAt?: Date | null

  @Property({ name: 'revoked_at', type: Date, nullable: true })
  revokedAt?: Date | null

  @Property({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason?: string | null

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Mandat o skończonym terminie, wydany robotowi.
 *
 * Wiersz istnieje głównie po to, żeby **centrala** wiedziała, do kiedy robot
 * uważa się za uprawnionego. Sam robot nie potrzebuje bazy: dostał liczbę
 * sekund i ma zegar. Gdyby potrzebował, odcięcie chmury byłoby zatrzymaniem
 * produkcji także w celi ogrodzonej.
 */
@Entity({ tableName: 'deployment_leases' })
@Index({ name: 'deployment_leases_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'deployment_leases_robot_idx', properties: ['robotId', 'issuedAt'] })
@Index({ name: 'deployment_leases_assignment_idx', properties: ['assignmentId', 'issuedAt'] })
@Unique({ name: 'deployment_leases_sequence_unique', properties: ['agentSessionId', 'sequence'] })
export class Lease {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'assignment_id', type: 'uuid' })
  assignmentId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  /**
   * Sesja agenta, która o dzierżawę poprosiła.
   *
   * Licznik kolejny jest per **sesja**, tak samo jak w kanale brzegowym:
   * agent po restarcie zaczyna od nowa, a licznik globalny odrzucałby każdy
   * legalny restart jako powtórkę.
   */
  @Property({ name: 'agent_session_id', type: 'uuid' })
  agentSessionId!: string

  @Property({ type: 'int' })
  sequence!: number

  @Property({ name: 'issued_at', type: Date, onCreate: () => new Date() })
  issuedAt: Date = new Date()

  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  @Property({ name: 'lease_seconds', type: 'int' })
  leaseSeconds!: number

  /** Odwołanie z centrali — działa tylko dotąd, dokąd sięga łącze. Patrz komentarz w `commands`. */
  @Property({ name: 'revoked_at', type: Date, nullable: true })
  revokedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Stan faktyczny zgłoszony przez robota.
 *
 * Dopisywany, nigdy nadpisywany. Kolumna „ostatni stan" byłaby wygodniejsza
 * i kłamałaby przy każdym migotaniu: rozjazd, który trwał dwie minuty
 * i sam się naprawił, jest informacją o wdrożeniu, a nie szumem do wyrzucenia.
 */
@Entity({ tableName: 'deployment_state_reports' })
@Index({ name: 'deployment_reports_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'deployment_reports_robot_idx', properties: ['robotId', 'reportedAt'] })
export class StateReport {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId?: string | null

  @Property({ name: 'reported_policy_version_id', type: 'uuid', nullable: true })
  reportedPolicyVersionId?: string | null

  @Property({ name: 'reported_state', type: 'text' })
  reportedState!: DesiredState

  /** Wynik uzgodnienia policzony przy zapisie: `converged` / `drift` / `unknown`. */
  @Property({ name: 'reconciliation', type: 'text' })
  reconciliation!: string

  @Property({ type: 'text' })
  reason!: string

  @Property({ name: 'reported_at', type: Date, onCreate: () => new Date() })
  reportedAt: Date = new Date()

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Kanał brzegowy: tożsamość oprogramowania na robocie i dowód, że ono żyje.
 *
 * Moduł jest celowo ubogi semantycznie. Zasada, którą trzeba trzymać przy
 * każdej kolejnej zmianie: **jeśli pojawia się tu potrzeba dołożenia pola
 * `policy_version_id`, `episode_id` albo czegokolwiek o treści pracy robota,
 * coś poszło źle.** `edge` odpowiada na dwa pytania i żadne inne:
 *
 *   1. Czy ten, kto się odzywa, jest tym, za kogo się podaje?
 *   2. Kiedy odezwał się ostatnio?
 *
 * Rozdział od `fleet` nie jest estetyczny. Robot trwa dziesięć lat, a klucz
 * kryptograficzny rotuje się co kwartał; komputer pokładowy bywa wymieniany
 * bez zmiany maszyny. Trzymanie klucza jako atrybutu robota kazałoby wersjonować
 * robota przy każdej rotacji - i mieszałoby dwie różne osie czasu.
 *
 * Kierunek zależności jest jednostronny: `edge` wie o `robot_id`, `fleet` nie
 * wie o agencie. Pulpit floty składa oba źródła po stronie przeglądarki,
 * dzięki czemu rejestr działa również wtedy, gdy kanału brzegowego nie ma.
 */

/** Stan agenta. Odwołanie jest nieodwracalne - nowy agent dostaje nową tożsamość. */
export type AgentStatus = 'enrolled' | 'revoked'

/**
 * Jednorazowy bilet wpisowy.
 *
 * W bazie leży **wyłącznie skrót** biletu. Jawna postać istnieje przez jedną
 * odpowiedź komendy i nigdy nie jest zapisywana - bo bilet wpisowy, który da
 * się odczytać z tabeli, jest kluczem do floty leżącym obok floty.
 */
@Entity({ tableName: 'edge_enrollment_tokens' })
@Index({ name: 'edge_tokens_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'edge_tokens_hash_unique', properties: ['tokenHash'] })
export class EnrollmentToken {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** Bilet jest wystawiany dla konkretnej maszyny, nie dla floty. */
  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'token_hash', type: 'text' })
  tokenHash!: string

  /**
   * Data wygaśnięcia jest obowiązkowa.
   *
   * Bilet bezterminowy to bilet, który zostaje w skrypcie instalacyjnym
   * i działa jeszcze trzy lata po wdrożeniu.
   */
  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  @Property({ name: 'used_at', type: Date, nullable: true })
  usedAt?: Date | null

  @Property({ name: 'used_by_agent_id', type: 'uuid', nullable: true })
  usedByAgentId?: string | null

  @Property({ name: 'issued_by', type: 'uuid', nullable: true })
  issuedBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Oprogramowanie brzegowe przypisane do jednej maszyny.
 *
 * Tożsamością jest para `(tenant_id, robot_id)` wśród agentów nieodwołanych:
 * jeden robot ma w danej chwili co najwyżej jednego ważnego agenta. Drugi,
 * odzywający się równolegle, jest albo klonem, albo nieudanym wdrożeniem -
 * i jedno, i drugie ma wyjść na wierzch, a nie zostać po cichu zaakceptowane.
 */
@Entity({ tableName: 'edge_agents' })
@Index({ name: 'edge_agents_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'edge_agents_robot_idx', properties: ['tenantId', 'robotId'] })
export class Agent {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  /** `onboard` - komputer na robocie, `cell_controller` - sterownik celi, `sim` - symulacja. */
  @Property({ name: 'agent_kind', type: 'text', default: 'onboard' })
  agentKind: 'onboard' | 'cell_controller' | 'sim' = 'onboard'

  @Property({ name: 'agent_version', type: 'text', nullable: true })
  agentVersion?: string | null

  @Property({ type: 'text', default: 'enrolled' })
  status: AgentStatus = 'enrolled'

  /**
   * Odstęp między uderzeniami serca i okres tolerancji, w sekundach.
   *
   * Liczby przychodzą z zewnątrz - nadaje je ten, kto wystawia bilet wpisowy,
   * na podstawie klasy ryzyka celi. `edge` przechowuje je i egzekwuje, ale
   * **nie wie, skąd się wzięły**, i celowo nie ma dostępu do klasy ryzyka.
   * Tu kończy się kanał, a zaczyna dziedzina.
   */
  @Property({ name: 'heartbeat_interval_seconds', type: 'int', default: 30 })
  heartbeatIntervalSeconds: number = 30

  @Property({ name: 'liveness_grace_seconds', type: 'int', default: 30 })
  livenessGraceSeconds: number = 30

  /**
   * Po ilu sekundach ciszy agent jest uznany za utraconego, a nie spóźnionego.
   *
   * Rozdział „spóźniony" od „utracony" jest tu sednem: pierwsze to sieć,
   * drugie to odcięte zasilanie. Reakcja jest inna, więc stan też.
   */
  @Property({ name: 'lost_after_seconds', type: 'int', default: 300 })
  lostAfterSeconds: number = 300

  @Property({ name: 'last_seen_at', type: Date, nullable: true })
  lastSeenAt?: Date | null

  @Property({ name: 'enrolled_at', type: Date, onCreate: () => new Date() })
  enrolledAt: Date = new Date()

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
 * Materiał klucza publicznego agenta.
 *
 * Osobna tabela, bo klucze rotują, a rotacja musi mieć **okno zakładkowe**:
 * przez chwilę ważne są dwa klucze naraz, inaczej każda rotacja byłaby
 * zaplanowanym zerwaniem łączności. Historia kluczy zostaje, bo pytanie
 * „którym kluczem podpisano ten heartbeat sprzed pół roku" jest pytaniem
 * audytowym, nie ciekawostką.
 */
@Entity({ tableName: 'edge_agent_keys' })
@Index({ name: 'edge_keys_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'edge_keys_agent_idx', properties: ['agentId', 'activeFrom'] })
@Unique({ name: 'edge_keys_fingerprint_unique', properties: ['tenantId', 'fingerprint'] })
export class AgentKey {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'agent_id', type: 'uuid' })
  agentId!: string

  /** Klucz publiczny w postaci PEM/SPKI. Prywatny nie opuszcza robota. */
  @Property({ name: 'public_key', type: 'text' })
  publicKey!: string

  @Property({ type: 'text', default: 'ed25519' })
  algorithm: string = 'ed25519'

  /** Skrót klucza - tym operator porównuje to, co widzi na robocie, z tym, co w bazie. */
  @Property({ type: 'text' })
  fingerprint!: string

  @Property({ name: 'active_from', type: Date, onCreate: () => new Date() })
  activeFrom: Date = new Date()

  /** Koniec okna zakładkowego; `null` znaczy „klucz bieżący". */
  @Property({ name: 'active_until', type: Date, nullable: true })
  activeUntil?: Date | null

  @Property({ name: 'revoked_at', type: Date, nullable: true })
  revokedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Nieprzerwany okres łączności agenta z centralą.
 *
 * Sesja, a nie tylko `last_seen_at`, bo liczba sesji na dobę jest miarą
 * migotania łącza - a migoczący robot i robot stabilny wyglądają w kolumnie
 * „ostatnio widziany" identycznie.
 *
 * Licznik `last_sequence` jest per sesja, nie per agent: agent po restarcie
 * zaczyna liczyć od nowa, więc licznik globalny odrzucałby każdy legalny
 * restart jako powtórkę. Wykrywanie klonów opiera się za to na tym, że dwie
 * żywe sesje tego samego agenta nie mogą istnieć naraz - starsza jest
 * wypierana i ten fakt zostaje zapisany.
 */
@Entity({ tableName: 'edge_agent_sessions' })
@Index({ name: 'edge_sessions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'edge_sessions_agent_idx', properties: ['agentId', 'startedAt'] })
@Index({ name: 'edge_sessions_open_idx', properties: ['tenantId', 'endedAt'] })
export class AgentSession {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'agent_id', type: 'uuid' })
  agentId!: string

  /** Którym kluczem otwarto sesję - żeby rotacja była widoczna w historii. */
  @Property({ name: 'key_id', type: 'uuid' })
  keyId!: string

  @Property({ name: 'agent_version', type: 'text', nullable: true })
  agentVersion?: string | null

  @Property({ name: 'started_at', type: Date, onCreate: () => new Date() })
  startedAt: Date = new Date()

  @Property({ name: 'last_heartbeat_at', type: Date, nullable: true })
  lastHeartbeatAt?: Date | null

  @Property({ name: 'last_sequence', type: 'int', default: 0 })
  lastSequence: number = 0

  @Property({ name: 'heartbeat_count', type: 'int', default: 0 })
  heartbeatCount: number = 0

  @Property({ name: 'ended_at', type: Date, nullable: true })
  endedAt?: Date | null

  /** `superseded` - ktoś otworzył drugą sesję, `timeout` - cisza, `revoked` - odwołanie agenta. */
  @Property({ name: 'ended_reason', type: 'text', nullable: true })
  endedReason?: 'superseded' | 'timeout' | 'revoked' | 'graceful' | null
}

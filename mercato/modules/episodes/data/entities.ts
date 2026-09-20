import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Księga epizodów i interwencji.
 *
 * Epizod jest atomem pracy manipulatora stacjonarnego: jedno podejście do
 * jednego zadania, z wynikiem. Interwencja człowieka jest **osobnym obiektem
 * pierwszorzędnym**, a nie polem `aborted_by` na epizodzie - i to jest całe
 * rozstrzygnięcie tej fazy.
 *
 * Powód nie jest estetyczny. Interwencja ma własny czas, własny etap, własnego
 * sprawcę i własną przyczynę; wtłoczona w kolumnę epizodu gubi wszystkie
 * cztery, a wtedy jedyne, co da się o niej powiedzieć, to że była. Liczba
 * epizodów między interwencjami - jedyna liczba, która mówi, czy wdrożenie
 * idzie do przodu - daje się policzyć i z pola, i z tabeli. Ale pytanie
 * „na którym etapie ludzie przerywają najczęściej", od którego zaczyna się
 * następny trening, daje się zadać wyłącznie tabeli.
 *
 * Czego tu świadomie nie ma: telemetrii (dane przebiegów nie przechodzą przez
 * MikroORM), obrazów z kamer, trajektorii. Epizod niesie **metryki**, czyli
 * kilkanaście liczb, a nie zapis przebiegu.
 */

export type EpisodeOutcome = 'success' | 'failure' | 'aborted' | 'timeout'

/**
 * Rodzaj interwencji, uporządkowany rosnąco po ciężarze.
 *
 * `adjust` - człowiek poprawił coś w otoczeniu, robot pracował dalej.
 * `manual_reset` - robot stanął, człowiek go odblokował.
 * `teleop_takeover` - człowiek przejął sterowanie.
 * `abort` - człowiek przerwał zadanie.
 * `estop` - zatrzymanie awaryjne.
 *
 * Kolejność jest treścią: raport, który liczy wszystkie przerwania razem,
 * pokazuje wdrożenie dojrzałe (same `adjust`) identycznie jak wdrożenie
 * niebezpieczne (same `estop`).
 */
export type InterventionKind = 'adjust' | 'manual_reset' | 'teleop_takeover' | 'abort' | 'estop'

@Entity({ tableName: 'episodes_episodes' })
@Index({ name: 'episodes_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'episodes_robot_idx', properties: ['robotId', 'sequence'] })
@Index({ name: 'episodes_policy_idx', properties: ['policyVersionId', 'startedAt'] })
@Index({ name: 'episodes_cell_idx', properties: ['cellId', 'startedAt'] })
@Unique({ name: 'episodes_external_ref_unique', properties: ['tenantId', 'robotId', 'externalRef'] })
export class Episode {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  /**
   * Wersja polityki, która ten epizod wykonała.
   *
   * Dopuszczalny `null`: epizod przeprowadzony ręcznie albo teleoperacyjnie
   * też jest epizodem i też wchodzi do księgi. Wykluczenie go zawyżałoby
   * autonomię dokładnie o te przypadki, w których jej nie było.
   */
  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  @Property({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId?: string | null

  /**
   * Numer kolejny epizodu w obrębie robota.
   *
   * Nadawany przez centralę przy zapisie, nie przez agenta: agent po restarcie
   * zaczyna liczyć od nowa, a kadencja autonomii liczona jest po całym życiu
   * maszyny. Numer agenta, jeśli istnieje, ląduje w `external_ref`.
   */
  @Property({ type: 'int' })
  sequence!: number

  /** Identyfikator epizodu po stronie robota - klucz idempotencji ponownego wysłania. */
  @Property({ name: 'external_ref', type: 'text' })
  externalRef!: string

  @Property({ name: 'task_key', type: 'text' })
  taskKey!: string

  @Property({ name: 'started_at', type: Date })
  startedAt!: Date

  @Property({ name: 'ended_at', type: Date })
  endedAt!: Date

  @Property({ name: 'duration_ms', type: 'int' })
  durationMs!: number

  @Property({ type: 'text' })
  outcome!: EpisodeOutcome

  /** Powód niepowodzenia w słowach robota - nie zastępuje przyczyny interwencji. */
  @Property({ name: 'outcome_detail', type: 'text', nullable: true })
  outcomeDetail?: string | null

  /**
   * Zdenormalizowany licznik interwencji przypadających na epizod.
   *
   * Prawdą pozostaje tabela interwencji; ta kolumna jest po to, żeby raport
   * kadencji dał się policzyć jednym przejściem po księdze, a nie złączeniem
   * przy każdym odczycie. Rozjazd między kolumną a tabelą jest wykrywany
   * i **pokazywany** przez `verifyAgainstLedger`, a nie zamiatany.
   */
  @Property({ name: 'intervention_count', type: 'int', default: 0 })
  interventionCount: number = 0

  /** Kilkanaście liczb: czas cyklu, liczba prób chwytu, siła, jakość ułożenia. */
  @Property({ type: 'json', nullable: true })
  metrics?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Przerwanie pracy przez człowieka - obiekt pierwszorzędny.
 *
 * Interwencja nie jest błędem do ukrycia w logach. Jest główną miarą
 * dojrzałości wdrożenia i wejściem do następnego treningu: to właśnie te
 * momenty stają się demonstracjami korekcyjnymi w zbiorze fazy 6.
 */
@Entity({ tableName: 'episodes_interventions' })
@Index({ name: 'episodes_interventions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'episodes_interventions_episode_idx', properties: ['episodeId'] })
@Index({ name: 'episodes_interventions_robot_idx', properties: ['robotId', 'occurredAt'] })
@Index({ name: 'episodes_interventions_kind_idx', properties: ['tenantId', 'kind', 'occurredAt'] })
export class Intervention {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /**
   * Epizod, w który interwencja uderzyła.
   *
   * `null` jest dopuszczalny i znaczy „między epizodami": człowiek przerwał
   * pracę stanowiska, gdy robot akurat nie wykonywał zadania. Wykluczenie
   * takich przypadków zaniżałoby licznik przerwań dokładnie w tych
   * wdrożeniach, w których robot stoi najczęściej.
   */
  @Property({ name: 'episode_id', type: 'uuid', nullable: true })
  episodeId?: string | null

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  @Property({ type: 'text' })
  kind!: InterventionKind

  /**
   * Etap zadania, na którym człowiek przerwał.
   *
   * Tekst swobodny, nie enum: etapy są własnością zadania, a nie platformy.
   * Wymuszenie wspólnego słownika dla chwytania z pojemnika i dla montażu
   * dałoby słownik pasujący do żadnego z nich.
   */
  @Property({ type: 'text', nullable: true })
  stage?: string | null

  /** Kategoria przyczyny - po niej grupuje się wnioski do następnego treningu. */
  @Property({ name: 'reason_category', type: 'text' })
  reasonCategory!: string

  @Property({ type: 'text' })
  reason!: string

  /** Kto przerwał. `null` znaczy: zadziałała warstwa bezpieczeństwa, nie człowiek. */
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'occurred_at', type: Date })
  occurredAt!: Date

  /** Ile trwał powrót do pracy. Bez tego „interwencja" nie ma kosztu. */
  @Property({ name: 'recovery_seconds', type: 'int', nullable: true })
  recoverySeconds?: number | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Uzasadnienie bezpieczeństwa, ewaluacja i incydenty.
 *
 * To jest warstwa, która odpowiada regulatorowi: rozporządzenie (UE) 2023/1230
 * (stosowane od 20 stycznia 2027), AI Act art. 6 ust. 1, ISO 10218-1/-2:2025,
 * ISO/TS 15066:2016.
 *
 * Rozstrzygnięcie nośne siedzi w kolumnie `cell_class` na uzasadnieniu:
 * **dopuszczenie dotyczy klasy celi, nie pojedynczej celi**. Klucz obcy do
 * `fleet_cells` byłby tu naturalny i byłby błędem - każda nowa cela o tej samej,
 * niezmienionej konfiguracji wymagałaby wtedy osobnego uzasadnienia, a to jest
 * koszt, którego nikt nie poniesie. W praktyce kończy się dopuszczeniami
 * udzielanymi hurtem bez czytania.
 *
 * Drugie rozstrzygnięcie siedzi w kolumnie `declared_as_safety_function`:
 * pole istnieje **po to, żeby było zawsze fałszem**. Uczona polityka
 * w łańcuchu bezpieczeństwa wpycha produkt klienta w Annex I część A, czyli
 * w ocenę przez jednostkę notyfikowaną, dla której nie ma ustalonej metody
 * wykazania zgodności. Platforma ma to wymuszać i dokumentować, a nie zakładać.
 */

export type SafetyCaseStatus = 'draft' | 'approved' | 'withdrawn' | 'expired'
export type EvalResult = 'pass' | 'fail' | 'error'

@Entity({ tableName: 'safety_cases' })
@Index({ name: 'safety_cases_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'safety_cases_class_idx', properties: ['tenantId', 'cellClass', 'status'] })
@Unique({ name: 'safety_cases_version_class_unique', properties: ['tenantId', 'policyVersionId', 'cellClass'] })
export class SafetyCase {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  /** Klasa celi, nie cela. Patrz komentarz przy module. */
  @Property({ name: 'cell_class', type: 'text' })
  cellClass!: string

  @Property({ name: 'risk_class', type: 'text' })
  riskClass!: string

  @Property({ type: 'text', default: 'draft' })
  status: SafetyCaseStatus = 'draft'

  /**
   * Czy polityka została zadeklarowana jako funkcja bezpieczeństwa.
   *
   * Pole istnieje po to, żeby było zawsze fałszem, i po to, żeby próba
   * ustawienia go na prawdę była jawną, zapisaną decyzją, a nie milczącym
   * założeniem. Dopuszczenie odmawia bezwarunkowo, gdy jest prawdą - żaden
   * komplet ewaluacji tego nie obchodzi.
   */
  @Property({ name: 'declared_as_safety_function', type: 'boolean', default: false })
  declaredAsSafetyFunction: boolean = false

  /** Zidentyfikowane zagrożenia i środki ograniczające, w postaci ustrukturyzowanej. */
  @Property({ type: 'json', nullable: true })
  hazards?: Array<Record<string, unknown>> | null

  /** Normy i przepisy przywołane w uzasadnieniu - ląduje w dokumentacji technicznej. */
  @Property({ type: 'json', nullable: true })
  standards?: string[] | null

  /**
   * Opis deterministycznej warstwy bezpieczeństwa, która egzekwuje ograniczenia.
   *
   * Pole obowiązkowe przy zatwierdzeniu: uzasadnienie, które nie wskazuje,
   * **co** zatrzyma maszynę, gdy polityka zawiedzie, nie jest uzasadnieniem.
   */
  @Property({ name: 'safety_layer', type: 'text', nullable: true })
  safetyLayer?: string | null

  /**
   * Rodzaj deterministycznej warstwy bezpieczeństwa - ze słownika zamkniętego.
   *
   * Dołożone, gdy do systemu wszedł mocny węzeł obliczeniowy. Do tej pory
   * `safetyLayer` był wolnym tekstem sprawdzanym wyłącznie na niepustość,
   * więc dało się tam wpisać „model na DGX Sparku" i uzasadnienie przechodziło.
   *
   * Słownik zamknięty odbiera tę możliwość na poziomie typu: wszystkie
   * dopuszczone pozycje są mechanizmami deterministycznymi, niezależnymi od
   * polityki i od tego, co akurat liczy akcelerator. Wyuczonego modelu nie da
   * się w tym polu **wyrazić** - a to jest mocniejsze niż odmowa po sprawdzeniu.
   */
  @Property({ name: 'safety_layer_kind', type: 'text', nullable: true })
  safetyLayerKind?: string | null

  @Property({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy?: string | null

  @Property({ name: 'approved_at', type: Date, nullable: true })
  approvedAt?: Date | null

  /**
   * Data ważności uzasadnienia.
   *
   * Obowiązkowa przy zatwierdzeniu, tak jak data ważności kalibracji
   * w rejestrze floty i z tego samego powodu: dopuszczenie bez terminu jest
   * dopuszczeniem, o którym nikt nigdy nie przypomni.
   */
  @Property({ name: 'valid_until', type: Date, nullable: true })
  validUntil?: Date | null

  @Property({ name: 'withdrawn_reason', type: 'text', nullable: true })
  withdrawnReason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Zestaw ewaluacyjny wymagany przed dopuszczeniem.
 *
 * `required_for` to lista klas ryzyka, nie jedna wartość: ten sam zestaw
 * bywa obowiązkowy w przestrzeni dzielonej i publicznej, a bez znaczenia
 * w celi ogrodzonej. Limity siły i nacisku z ISO/TS 15066 mają sens tam,
 * gdzie kontakt z człowiekiem jest możliwy; wymaganie ich za płotem byłoby
 * rytuałem, a rytuały uczą omijania wymagań.
 */
@Entity({ tableName: 'safety_eval_suites' })
@Index({ name: 'safety_suites_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'safety_suites_key_unique', properties: ['tenantId', 'suiteKey'] })
export class EvalSuite {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'suite_key', type: 'text' })
  suiteKey!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'required_for', type: 'json' })
  requiredFor!: string[]

  @Property({ name: 'case_count', type: 'int', nullable: true })
  caseCount?: number | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Przebieg zestawu ewaluacyjnego dla konkretnej wersji polityki.
 *
 * Dopisywany, nigdy nadpisywany. Zestaw przebiegnięty ponownie po zmianie
 * w celi i zakończony niepowodzeniem unieważnia poprzedni sukces -
 * dopuszczenie bierze **najnowszy** przebieg, a nie jakikolwiek zaliczony.
 * Szukanie „czy kiedykolwiek przeszedł" dawałoby dopuszczenia na podstawie
 * wyniku sprzed roku.
 */
@Entity({ tableName: 'safety_eval_runs' })
@Index({ name: 'safety_runs_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'safety_runs_version_idx', properties: ['policyVersionId', 'suiteKey', 'ranAt'] })
export class EvalRun {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  @Property({ name: 'suite_key', type: 'text' })
  suiteKey!: string

  @Property({ type: 'text' })
  result!: EvalResult

  @Property({ name: 'passed_cases', type: 'int', nullable: true })
  passedCases?: number | null

  @Property({ name: 'total_cases', type: 'int', nullable: true })
  totalCases?: number | null

  /**
   * Odcisk kontraktu embodimentu, na którym zestaw przebiegł.
   *
   * Bez tego dopuszczenie opierałoby się na testach z innego sprzętu -
   * najczęstsza droga do zgody „na podstawie ewaluacji", której nikt nie
   * powtórzył po wymianie chwytaka.
   */
  @Property({ name: 'embodiment_spec_digest', type: 'text', nullable: true })
  embodimentSpecDigest?: string | null

  /** Wskaźnik do zapisu przebiegu w magazynie obiektów. Nigdy same dane. */
  @Property({ name: 'evidence_uri', type: 'text', nullable: true })
  evidenceUri?: string | null

  @Property({ name: 'ran_at', type: Date })
  ranAt!: Date

  @Property({ name: 'ran_by', type: 'uuid', nullable: true })
  ranBy?: string | null

  @Property({ type: 'json', nullable: true })
  details?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Rejestr incydentów.
 *
 * Klasyfikacja jest dwuwymiarowa: **czy ktoś ucierpiał** i **czy zawiodła
 * warstwa bezpieczeństwa**. Pojedyncza skala ciężkości skleiłaby te pytania
 * i zgubiła najważniejszy przypadek - zdarzenie bez skutków, w którym warstwa
 * deterministyczna zadziałała na ostatniej linii.
 */
@Entity({ tableName: 'safety_incidents' })
@Index({ name: 'safety_incidents_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'safety_incidents_robot_idx', properties: ['robotId', 'occurredAt'] })
@Index({ name: 'safety_incidents_version_idx', properties: ['policyVersionId', 'occurredAt'] })
export class Incident {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid', nullable: true })
  robotId?: string | null

  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  @Property({ name: 'cell_class', type: 'text', nullable: true })
  cellClass?: string | null

  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  @Property({ name: 'episode_id', type: 'uuid', nullable: true })
  episodeId?: string | null

  /** `none` | `near_miss` | `first_aid` | `lost_time` | `serious` */
  @Property({ type: 'text' })
  harm!: string

  @Property({ name: 'safety_layer_engaged', type: 'boolean', default: false })
  safetyLayerEngaged: boolean = false

  @Property({ name: 'policy_implicated', type: 'boolean', default: false })
  policyImplicated: boolean = false

  /** Wynik klasyfikacji policzony przy zapisie - patrz `lib/clearance.ts`. */
  @Property({ type: 'text' })
  priority!: string

  @Property({ name: 'halt_deployment', type: 'boolean', default: false })
  haltDeployment: boolean = false

  @Property({ type: 'text' })
  description!: string

  @Property({ name: 'occurred_at', type: Date })
  occurredAt!: Date

  @Property({ name: 'reported_by', type: 'uuid', nullable: true })
  reportedBy?: string | null

  /** Czy zdarzenie zostało zgłoszone organowi nadzoru. Data, nie flaga. */
  @Property({ name: 'reported_to_authority_at', type: Date, nullable: true })
  reportedToAuthorityAt?: Date | null

  @Property({ name: 'root_cause', type: 'text', nullable: true })
  rootCause?: string | null

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type { LeaseExpiryBehavior, PolicyVectorSpec } from '../lib/vectorContract'

/**
 * Rejestr polityk — wyuczonych sterowników i ich artefaktów.
 *
 * Trzy rozstrzygnięcia przesądzone przed pierwszą tabelą:
 *
 * 1. **Tożsamością wersji jest skrót artefaktów, nie numer.** Numer jest
 *    etykietą dla ludzi; to, co naprawdę odróżnia dwie wersje, to bity wag.
 *    Dwa wgrania tych samych wag są jedną wersją, bo fizycznie są jedną
 *    polityką. Alternatywa — numer nadawany przy każdym wgraniu — odrzucona,
 *    bo tworzy dwa rekordy dla jednego zachowania i unieważnia każdą statystykę
 *    liczoną per wersja (a na tych statystykach stoi cała faza 4).
 *
 * 2. **Wersja wiąże się z rewizją embodimentu, nie z robotem.** Robot jest
 *    egzemplarzem; kontraktem jest rewizja. To jedyne miejsce, w którym da się
 *    powiedzieć „ta polityka fizycznie nie może działać na tym sprzęcie"
 *    *przed* wdrożeniem, a nie po pierwszym ruchu ramienia.
 *
 * 3. **Wersja jest niezmienna.** Nie ma komendy edycji wersji. Zmiana wag to
 *    nowa wersja; zmiana statusu to osobna kolumna z własnym dziennikiem.
 *
 * Czego tu świadomie nie ma: wdrożenia (to `deployment`), stanu pożądanego,
 * wyników ewaluacji (to `safety`) i — co najważniejsze — **samych binariów**.
 * W tabeli leży wskaźnik do magazynu obiektów i skrót; bajty wag nigdy nie
 * przechodzą przez MikroORM ani przez szynę komend. To jest granica
 * control plane / data plane zapisana w warunku trzecim raportu.
 */

/** Metoda, którą polityka powstała. Nie jest ozdobą: rządzi wymaganiami ewaluacyjnymi w fazie 5. */
export type LearningMethod = 'rl' | 'il' | 'offline_rl' | 'vla' | 'classical'

/**
 * Status wersji polityki.
 *
 * `registered` — istnieje, artefakty policzone, embodiment zweryfikowany.
 * `released`   — dopuszczona do użycia przez wdrożenia.
 * `deprecated` — wycofana z użycia; istniejące wdrożenia nie znikają, ale
 *                nowe przypisanie się nie uda.
 *
 * Nie ma tu `approved` — dopuszczenie bezpieczeństwa jest funkcją pary
 * (wersja, klasa celi) i mieszka w module `safety`. Trzymanie jednego pola
 * „zatwierdzona" sugerowałoby, że dopuszczenie jest własnością globalną wersji,
 * a to jest dokładnie ten błąd, który każe pisać osobne uzasadnienie dla każdej
 * celi z osobna.
 */
export type PolicyVersionStatus = 'registered' | 'released' | 'deprecated'

/** Rola artefaktu w komplecie. Wagi są obowiązkowe; reszta bywa. */
export type ArtifactRole = 'weights' | 'config' | 'preprocessor' | 'normalizer' | 'metadata'

@Entity({ tableName: 'policy_registry_policies' })
@Index({ name: 'policy_registry_policies_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'policy_registry_policies_key_unique', properties: ['tenantId', 'policyKey'] })
export class Policy {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** Stabilny identyfikator czytelny dla człowieka, np. `pick-bin-ur10e`. */
  @Property({ name: 'policy_key', type: 'text' })
  policyKey!: string

  @Property({ type: 'text' })
  name!: string

  /**
   * Rodzina embodimentu, dla której polityka w ogóle powstała.
   *
   * Pole obowiązkowe — to jest treść zdania „polityka bez zadeklarowanego
   * embodimentu nie daje się zapisać". Rewizję sprawdzamy dopiero przy wersji,
   * ale rodzinę deklaruje się od razu, żeby nie dało się założyć rejestru
   * polityk, o których nie wiadomo, czym mają ruszać.
   */
  @Property({ name: 'embodiment_key', type: 'text' })
  embodimentKey!: string

  /** Zadanie, które polityka wykonuje. Krótki opis dziedzinowy, nie nazwa sieci. */
  @Property({ name: 'task_key', type: 'text' })
  taskKey!: string

  @Property({ name: 'learning_method', type: 'text', default: 'rl' })
  learningMethod: LearningMethod = 'rl'

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Niezmienna wersja polityki.
 *
 * `content_digest` jest tożsamością: liczony z kompletu artefaktów w postaci
 * kanonicznej (patrz `lib/digest.ts`). Unikat `(tenant_id, policy_id,
 * content_digest)` sprawia, że drugie wgranie tych samych wag odbija się
 * od **bazy**, a nie od naszej pamięci — ta sama zasada, co przy unikacie
 * pomiaru kalibracyjnego w rejestrze floty.
 */
@Entity({ tableName: 'policy_registry_policy_versions' })
@Index({ name: 'policy_registry_versions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'policy_registry_versions_policy_idx', properties: ['policyId', 'version'] })
@Index({ name: 'policy_registry_versions_embodiment_idx', properties: ['embodimentRevisionId'] })
@Unique({ name: 'policy_registry_versions_digest_unique', properties: ['tenantId', 'policyId', 'contentDigest'] })
@Unique({ name: 'policy_registry_versions_number_unique', properties: ['tenantId', 'policyId', 'version'] })
export class PolicyVersion {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'policy_id', type: 'uuid' })
  policyId!: string

  /** Numer kolejny w obrębie polityki. Etykieta dla ludzi, nie tożsamość. */
  @Property({ type: 'int' })
  version!: number

  /** Tożsamość: skrót kanonicznego kompletu artefaktów. */
  @Property({ name: 'content_digest', type: 'text' })
  contentDigest!: string

  @Property({ name: 'embodiment_revision_id', type: 'uuid' })
  embodimentRevisionId!: string

  /**
   * Kopia `spec_digest` rewizji z chwili rejestracji — celowa denormalizacja.
   *
   * Rewizja embodimentu jest w innym module i teoretycznie niezmienna, ale
   * „teoretycznie niezmienna" to za mało dla zapisu, który ma odpowiedzieć
   * regulatorowi po trzech latach. Robot porównuje tę wartość lokalnie przed
   * załadowaniem wag i odmawia startu przy rozjeździe — bez pytania centrali.
   */
  @Property({ name: 'embodiment_spec_digest', type: 'text' })
  embodimentSpecDigest!: string

  @Property({ type: 'text', default: 'registered' })
  status: PolicyVersionStatus = 'registered'

  @Property({ name: 'status_reason', type: 'text', nullable: true })
  statusReason?: string | null

  @Property({ name: 'status_changed_at', type: Date, nullable: true })
  statusChangedAt?: Date | null

  /**
   * Skąd wzięła się ta wersja: przebieg treningowy, commit, zbiór danych.
   *
   * Zostaje luźnym JSON-em do fazy 6, w której zbiór staje się obiektem
   * pierwszorzędnym i dostaje własną tabelę powiązań. Do tego czasu lepiej
   * mieć tu nieustrukturyzowany ślad niż nie mieć żadnego.
   */
  @Property({ type: 'json', nullable: true })
  provenance?: Record<string, unknown> | null

  /** Deklarowane wymiary wejścia/wyjścia — najtańsza kontrola zdrowego rozsądku. */
  @Property({ name: 'observation_dim', type: 'int', nullable: true })
  observationDim?: number | null

  @Property({ name: 'action_dim', type: 'int', nullable: true })
  actionDim?: number | null

  /** Uporządkowane pola są częścią kontraktu — kolejność tablicy jest kolejnością wektora. */
  @Property({ name: 'observation_spec', type: 'json', nullable: true })
  observationSpec?: PolicyVectorSpec | null

  @Property({ name: 'action_spec', type: 'json', nullable: true })
  actionSpec?: PolicyVectorSpec | null

  @Property({ name: 'control_frequency_hz', type: 'double', nullable: true })
  controlFrequencyHz?: number | null

  @Property({ name: 'lease_expiry_behavior', type: 'text', nullable: true })
  leaseExpiryBehavior?: LeaseExpiryBehavior | null

  @Property({ name: 'registered_by', type: 'uuid', nullable: true })
  registeredBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Pojedynczy plik składający się na wersję: wagi, konfiguracja, preprocesor.
 *
 * `uri` wskazuje magazyn obiektów. Binarium nie leży w bazie i nie przechodzi
 * przez szynę komend — to nie jest optymalizacja, tylko warunek brzegowy
 * projektu. Baza trzyma skrót, żeby dało się stwierdzić, że plik pod tym
 * adresem to wciąż ten sam plik.
 */
@Entity({ tableName: 'policy_registry_artifacts' })
@Index({ name: 'policy_registry_artifacts_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'policy_registry_artifacts_version_idx', properties: ['policyVersionId'] })
@Unique({ name: 'policy_registry_artifacts_role_unique', properties: ['policyVersionId', 'role'] })
export class PolicyArtifact {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  /**
   * Rola, nie nazwa pliku.
   *
   * Unikat jest na `(policy_version_id, role)`: komplet ma najwyżej jedne wagi
   * i najwyżej jeden preprocesor. Dopuszczenie dwóch plików w tej samej roli
   * zrobiłoby ze skrótu treści wielkość zależną od kolejności wgrywania.
   */
  @Property({ type: 'text' })
  role!: ArtifactRole

  /** sha256 zawartości w hex. Liczony przez wgrywającego, weryfikowany przez robota. */
  @Property({ type: 'text' })
  digest!: string

  @Property({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes?: string | number | null

  @Property({ name: 'media_type', type: 'text', nullable: true })
  mediaType?: string | null

  /** Wskaźnik do magazynu obiektów — `s3://…`, `file://…`. Nigdy bajty. */
  @Property({ type: 'text' })
  uri!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Dziennik zmian statusu wersji — dopisywany, nigdy nadpisywany.
 *
 * Ta sama zasada, co w księdze przejść robota: poprawka jest kolejnym wpisem.
 * Tutaj chroni odpowiedź na pytanie „kto i kiedy wypuścił tę wersję na flotę".
 */
@Entity({ tableName: 'policy_registry_version_events' })
@Index({ name: 'policy_registry_events_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'policy_registry_events_version_idx', properties: ['policyVersionId', 'occurredAt'] })
export class PolicyVersionEvent {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'policy_version_id', type: 'uuid' })
  policyVersionId!: string

  @Property({ name: 'from_status', type: 'text', nullable: true })
  fromStatus?: PolicyVersionStatus | null

  @Property({ name: 'to_status', type: 'text' })
  toStatus!: PolicyVersionStatus

  @Property({ type: 'text' })
  reason!: string

  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'occurred_at', type: Date, onCreate: () => new Date() })
  occurredAt: Date = new Date()
}

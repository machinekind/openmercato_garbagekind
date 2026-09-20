import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Zbiory danych - zamknięcie pętli.
 *
 * Zdanie, które ten moduł ma uczynić prawdziwym: **dla dowolnej wersji polityki
 * da się wskazać zbiór, a dla zbioru - listę epizodów źródłowych, i odwrotnie.**
 *
 * Bez tego regres jakości po treningu jest nie do zdiagnozowania: polityka v7
 * zachowuje się gorzej od v6 i zostają dwie hipotezy - zmiana w danych albo
 * zmiana w treningu - których nie da się rozdzielić, jeśli nie wiadomo, czym
 * różniły się zbiory.
 *
 * Trzy rozstrzygnięcia:
 *
 * 1. **Wersja zbioru jest niezmienna, a jej tożsamością jest odcisk
 *    zawartości.** Ta sama zasada, co w rejestrze polityk, i z tego samego
 *    powodu: dwa przebiegi budowania dające ten sam zestaw epizodów to jedna
 *    wersja zbioru, i tylko wtedy zdanie „polityka v7 uczyła się na zbiorze X
 *    w wersji 3" cokolwiek znaczy.
 *
 * 2. **Skład zbioru to odniesienia do epizodów, nie kopia danych.** Tabela
 *    trzyma identyfikatory i role. Bajty przebiegów leżą w magazynie obiektów
 *    i nie przechodzą przez MikroORM - warunek trzeci raportu.
 *
 * 3. **Przebieg treningowy jest osobnym obiektem**, a nie polem na wersji
 *    polityki. Z jednego zbioru wychodzi zwykle kilka polityk (różne ziarna,
 *    różne hiperparametry), a jedna polityka bywa dostrajana na dwóch zbiorach
 *    po kolei. Pole nie uniesie żadnego z tych dwóch przypadków.
 */

export type MemberRole = 'demo' | 'correction' | 'failure' | 'holdout'

@Entity({ tableName: 'datasets_datasets' })
@Index({ name: 'datasets_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'datasets_key_unique', properties: ['tenantId', 'datasetKey'] })
export class Dataset {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'dataset_key', type: 'text' })
  datasetKey!: string

  @Property({ type: 'text' })
  name!: string

  /** Zadanie, którego zbiór dotyczy. Zbiór bez zadania jest workiem epizodów. */
  @Property({ name: 'task_key', type: 'text' })
  taskKey!: string

  /**
   * Rodzina embodimentu.
   *
   * Zbiór zebrany na jednym sprzęcie nie jest zbiorem dla innego. Pole
   * obowiązkowe z tego samego powodu, dla którego polityka musi deklarować
   * embodiment: inaczej nie ma miejsca, w którym da się powiedzieć „te dane
   * nie pasują do tej maszyny".
   */
  @Property({ name: 'embodiment_key', type: 'text' })
  embodimentKey!: string

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
 * Niezmienna wersja zbioru.
 *
 * Unikat na `(tenant, dataset, content_digest)` sprawia, że dwukrotne
 * zbudowanie tego samego zestawu epizodów odbija się od **bazy**, a nie od
 * naszej pamięci - ta sama zasada, co przy skrócie wag i przy identyfikatorze
 * epizodu z agenta.
 */
@Entity({ tableName: 'datasets_versions' })
@Index({ name: 'datasets_versions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'datasets_versions_dataset_idx', properties: ['datasetId', 'version'] })
@Unique({ name: 'datasets_versions_digest_unique', properties: ['tenantId', 'datasetId', 'contentDigest'] })
@Unique({ name: 'datasets_versions_number_unique', properties: ['tenantId', 'datasetId', 'version'] })
export class DatasetVersion {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'dataset_id', type: 'uuid' })
  datasetId!: string

  @Property({ type: 'int' })
  version!: number

  /** Tożsamość: odcisk posortowanej listy `episodeId:role`. */
  @Property({ name: 'content_digest', type: 'text' })
  contentDigest!: string

  @Property({ name: 'episode_count', type: 'int' })
  episodeCount!: number

  @Property({ name: 'demo_count', type: 'int', default: 0 })
  demoCount: number = 0

  @Property({ name: 'correction_count', type: 'int', default: 0 })
  correctionCount: number = 0

  @Property({ name: 'failure_count', type: 'int', default: 0 })
  failureCount: number = 0

  @Property({ name: 'holdout_count', type: 'int', default: 0 })
  holdoutCount: number = 0

  /**
   * Ostrzeżenia o składzie, zapisane przy budowaniu.
   *
   * Nie są twardą odmową i celowo nie są: zbiór czysto korekcyjny bywa
   * dokładnie tym, czego ktoś potrzebuje. Odmowa zmuszałaby do obchodzenia
   * systemu, a ostrzeżenie zapisane przy wersji wypływa przy diagnozie regresu.
   */
  @Property({ type: 'json', nullable: true })
  warnings?: Array<{ code: string; message: string }> | null

  /** Kryteria, po których zbiór został zbudowany - żeby dało się go odtworzyć. */
  @Property({ type: 'json', nullable: true })
  criteria?: Record<string, unknown> | null

  /** Wskaźnik do wyeksportowanej postaci w magazynie obiektów. Nigdy bajty. */
  @Property({ name: 'export_uri', type: 'text', nullable: true })
  exportUri?: string | null

  @Property({ name: 'built_by', type: 'uuid', nullable: true })
  builtBy?: string | null

  @Property({ name: 'built_at', type: Date, onCreate: () => new Date() })
  builtAt: Date = new Date()

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Epizod w składzie wersji zbioru.
 *
 * Wiersz jest odniesieniem, nie kopią. Rola jest tu istotniejsza niż
 * identyfikator: epizod zakończony sukcesem, w którym człowiek poprawił
 * chwyt, wchodzi jako `correction`, a nie `demo` - wrzucenie go do `demo`
 * uczyłoby model, że tak właśnie ma wyglądać poprawny przebieg.
 */
@Entity({ tableName: 'datasets_members' })
@Index({ name: 'datasets_members_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'datasets_members_version_idx', properties: ['datasetVersionId', 'role'] })
@Index({ name: 'datasets_members_episode_idx', properties: ['episodeId'] })
@Unique({ name: 'datasets_members_unique', properties: ['datasetVersionId', 'episodeId'] })
export class DatasetMember {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'dataset_version_id', type: 'uuid' })
  datasetVersionId!: string

  @Property({ name: 'episode_id', type: 'uuid' })
  episodeId!: string

  @Property({ type: 'text' })
  role!: MemberRole

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Przebieg treningowy - ogniwo łączące zbiór z polityką.
 *
 * Osobna tabela, nie pole na wersji polityki. Z jednego zbioru wychodzi
 * zwykle kilka polityk (różne ziarna, różne hiperparametry), a jedna polityka
 * bywa dostrajana kolejno na dwóch zbiorach. Pole nie uniesie żadnego z tych
 * przypadków, a właśnie one są normą w praktyce.
 *
 * `policy_version_id` jest nullowalne: przebieg zarejestrowany przed
 * zakończeniem treningu jeszcze nie ma wyniku, a przebieg nieudany nie będzie
 * go miał nigdy - i też jest informacją o zbiorze.
 */
@Entity({ tableName: 'datasets_training_runs' })
@Index({ name: 'datasets_runs_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'datasets_runs_version_idx', properties: ['datasetVersionId'] })
@Index({ name: 'datasets_runs_policy_idx', properties: ['policyVersionId'] })
@Unique({ name: 'datasets_runs_ref_unique', properties: ['tenantId', 'runRef'] })
export class TrainingRun {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'dataset_version_id', type: 'uuid' })
  datasetVersionId!: string

  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  /** Identyfikator przebiegu w systemie treningowym - klucz idempotencji. */
  @Property({ name: 'run_ref', type: 'text' })
  runRef!: string

  @Property({ type: 'text', nullable: true })
  framework?: string | null

  /** Hiperparametry i ziarno - bez nich „ten sam zbiór" nie tłumaczy różnicy wyników. */
  @Property({ type: 'json', nullable: true })
  hyperparameters?: Record<string, unknown> | null

  @Property({ type: 'text', default: 'running' })
  status: 'running' | 'succeeded' | 'failed' = 'running'

  @Property({ name: 'started_at', type: Date })
  startedAt!: Date

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

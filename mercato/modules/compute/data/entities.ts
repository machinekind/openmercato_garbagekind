import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Rejestr węzłów obliczeniowych.
 *
 * Powstał, bo do systemu wchodzi mocna maszyna i trzeba z góry rozstrzygnąć
 * dwie rzeczy, których potem nikt nie rozstrzygnie: **co na niej wolno
 * uruchomić** i **czego na niej uruchomić nie wolno nigdy**.
 *
 * Druga jest ważniejsza. Kuszenie jest przewidywalne: jak już stoi maszyna
 * licząca petaflop, wszystko chce na niej wylądować - łącznie z warstwą,
 * która ma zatrzymać robota, gdy polityka zawiedzie. Ta warstwa musi być
 * deterministyczna i **niezależna od polityki**, a współdzielony system
 * ogólnego przeznaczenia z akceleratorem nie daje ani jednego, ani drugiego.
 *
 * Czego tu nie ma: telemetrii węzła, kolejki zadań, harmonogramu. To jest
 * rejestr zdolności i przypisań, a nie orkiestrator. Jeśli pojawi się tu
 * pole `job_status`, modelowanie poszło w stronę, w której ERP udaje
 * Kubernetes.
 */

@Entity({ tableName: 'compute_nodes' })
@Index({ name: 'compute_nodes_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'compute_nodes_code_unique', properties: ['tenantId', 'code'] })
export class ComputeNode {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ type: 'text' })
  name!: string

  /** `dgx_spark`, `jetson`, `workstation`, `server`, `cloud`. */
  @Property({ type: 'text' })
  kind!: string

  /** Cela, przy której węzeł stoi; `null` znaczy „centralnie, nie przy maszynie". */
  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  @Property({ name: 'memory_gb', type: 'int' })
  memoryGb!: number

  /**
   * Przepustowość pamięci w GB/s.
   *
   * Pole obowiązkowe, bo **to ona, a nie moc obliczeniowa, rozstrzyga
   * o wydajności wnioskowania autoregresyjnego**. Rejestr bez tej liczby
   * pozwalałby planować obciążenia na podstawie nagłówka z arkusza danych.
   */
  @Property({ name: 'memory_bandwidth_gbs', type: 'int' })
  memoryBandwidthGbs!: number

  @Property({ name: 'compute_tflops', type: 'double' })
  computeTflops!: number

  /**
   * Precyzja, dla której podano moc obliczeniową.
   *
   * Bez tego pola liczba TFLOPS nic nie znaczy: ten sam układ ma inną moc
   * w FP4 i w FP16, a podstawienie jednej do rachunku dla drugiej **odwraca
   * werdykt o wąskim gardle**. Sprawdzone na własnym teście.
   */
  @Property({ name: 'compute_precision', type: 'text' })
  computePrecision!: string

  /** Role z zamkniętego słownika; `safety_function` w nim nie istnieje. */
  @Property({ type: 'json' })
  roles!: string[]

  /**
   * Czy to maszyna ogólnego przeznaczenia dzielona między zadania.
   *
   * Osobno od `realtimeCapable`, bo to dwie różne wady: współdzielenie psuje
   * niezależność, brak czasu rzeczywistego psuje determinizm. Warstwa
   * bezpieczeństwa potrzebuje obu naraz.
   */
  @Property({ name: 'shared_general_purpose', type: 'boolean', default: true })
  sharedGeneralPurpose: boolean = true

  @Property({ name: 'realtime_capable', type: 'boolean', default: false })
  realtimeCapable: boolean = false

  @Property({ type: 'text', default: 'active' })
  status: 'active' | 'retired' = 'active'

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Co na którym węźle działa albo działało.
 *
 * Wpis jest przedziałem czasu, nie stanem bieżącym: pytanie „na czym trenowano
 * wersję, która zaczęła gubić sztuki" pada po fakcie i wymaga historii.
 * To domyka lukę w `datasets_training_runs`, gdzie przebieg treningowy nie
 * zapisywał, **na czym** się odbył - a bez tego regres po zmianie sterownika
 * albo biblioteki jest nie do zdiagnozowania.
 */
@Entity({ tableName: 'compute_placements' })
@Index({ name: 'compute_placements_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'compute_placements_node_idx', properties: ['nodeId', 'startedAt'] })
@Index({ name: 'compute_placements_workload_idx', properties: ['tenantId', 'workloadType', 'workloadRef'] })
export class Placement {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'node_id', type: 'uuid' })
  nodeId!: string

  /** `training_run`, `detector_version`, `policy_version`, `simulation`. */
  @Property({ name: 'workload_type', type: 'text' })
  workloadType!: string

  @Property({ name: 'workload_ref', type: 'uuid' })
  workloadRef!: string

  /**
   * Wersja narzędzi, przy której obciążenie działało.
   *
   * Sterownik i biblioteka wnioskowania zmieniają wynik przy niezmienionych
   * wagach. Bez tego pola „ta sama wersja polityki zachowuje się inaczej niż
   * miesiąc temu" nie ma gdzie znaleźć wyjaśnienia.
   */
  @Property({ type: 'json', nullable: true })
  toolchain?: Record<string, unknown> | null

  @Property({ name: 'started_at', type: Date })
  startedAt!: Date

  @Property({ name: 'ended_at', type: Date, nullable: true })
  endedAt?: Date | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

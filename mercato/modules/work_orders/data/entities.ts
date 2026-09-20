import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Most między halą a przedsiębiorstwem.
 *
 * Tu spotykają się dwa światy, które do tej pory stały osobno: moduł
 * `sortownia` prowadzący zamówienia, faktury i magazyn, oraz osiem modułów
 * robotycznych prowadzących roboty, polityki i epizody. Ten moduł nie dokłada
 * trzeciego świata - dokłada **przeliczenie jednego na drugi** i jeden
 * rachunek kontrolny.
 *
 * Dwie decyzje przesądzone przed pierwszą tabelą:
 *
 * 1. **Masa do magazynu idzie z wagi, nigdy z deklaracji robota.** Robot mówi
 *    „wykonałem 812 udanych chwytów". To jest jego zdanie o sobie. Do stanu
 *    magazynowego wchodzi to, co pokazała waga, a różnica między jednym
 *    a drugim jest **miarą błędu robota zmierzoną względem fizyki**, a nie
 *    względem jego własnego dziennika. Gdyby deklaracja stawała się zapasem,
 *    robot gubiący co dziesiątą sztukę byłby niewidoczny w każdym zestawieniu.
 *
 * 2. **Most jest jednokierunkowy dla materiału i nie dyspozytorski dla pracy.**
 *    Epizody stają się masą; zamówienie sprzedaży **nie** uruchamia robota
 *    samo z siebie. Zlecenie robocze zakłada człowiek. ERP ma opóźnienia
 *    i tryby awarii właściwe dla systemu ewidencyjnego, nie dla sterowania
 *    ruchem - a zamówienie, które samo porusza maszyną, jest dokładnie tym
 *    sprzężeniem, przez które błąd w ERP zatrzymuje albo rozpędza halę.
 *
 * Masy trzymamy w **gramach jako liczbach całkowitych**. Kilogramy
 * zmiennoprzecinkowe zemściły się już raz przy bilansie masy w sortowni:
 * suma stu ruchów po 3803,73 kg nie jest tym samym, co suma tych samych stu
 * ruchów wczytanych w innej kolejności. Przeliczenie na kilogramy dzieje się
 * na granicy - przy wywołaniu komendy magazynowej i na ekranie.
 */

export type WorkOrderStatus = 'open' | 'completed' | 'cancelled'
export type BatchStatus = 'filling' | 'closed' | 'discarded'

/**
 * Zlecenie robocze: która cela ma wyprodukować ile czego i na czyją rzecz.
 *
 * Wiąże trzy identyfikatory z trzech różnych światów - celę z rejestru floty,
 * wariant katalogowy z ERP i (opcjonalnie) zamówienie sprzedaży. To jest cała
 * treść „centralnego panelu": jedno miejsce, w którym te trzy rzeczy stoją
 * w jednym wierszu.
 */
@Entity({ tableName: 'work_orders_orders' })
@Index({ name: 'work_orders_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'work_orders_cell_idx', properties: ['tenantId', 'cellId', 'status'] })
@Unique({ name: 'work_orders_number_unique', properties: ['tenantId', 'orderNumber'] })
export class WorkOrder {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'order_number', type: 'text' })
  orderNumber!: string

  /** Cela z rejestru floty. Zlecenie dotyczy stanowiska, nie pojedynczej maszyny. */
  @Property({ name: 'cell_id', type: 'uuid' })
  cellId!: string

  /**
   * Wersja polityki, którą zlecenie ma być wykonane.
   *
   * Opcjonalna, bo zlecenie bywa realizowane ręcznie albo mieszanie. Gdy jest
   * podana, uzgodnienie przypisuje błąd **tej wersji** - i to jest jedyny
   * sposób, żeby powiedzieć „v2 gubi więcej sztuk niż v1" w kilogramach,
   * a nie w procentach z własnego dziennika robota.
   */
  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  @Property({ name: 'catalog_variant_id', type: 'uuid' })
  catalogVariantId!: string

  /** Kod odpadu / SKU frakcji - ta sama tożsamość, co w module `sortownia`. */
  @Property({ type: 'text' })
  sku!: string

  @Property({ name: 'warehouse_id', type: 'uuid' })
  warehouseId!: string

  @Property({ name: 'location_id', type: 'uuid' })
  locationId!: string

  /** Cel zlecenia w gramach. */
  @Property({ name: 'target_grams', type: 'bigint' })
  targetGrams!: number

  /**
   * Masa nominalna jednej sztuki, w gramach.
   *
   * To jest najbardziej niepewna liczba w całym module i dlatego stoi na
   * zleceniu, a nie w konfiguracji globalnej: butelka PET z tej linii waży
   * co innego niż butelka z tamtej. Uzgodnienie bez tej liczby jest możliwe,
   * ale daje werdykt `no_reference` - i tak ma być, zamiast podstawiać średnią.
   */
  @Property({ name: 'nominal_piece_grams', type: 'int', nullable: true })
  nominalPieceGrams?: number | null

  /** Zamówienie sprzedaży, na którego rzecz zlecenie powstało. */
  @Property({ name: 'sales_order_id', type: 'uuid', nullable: true })
  salesOrderId?: string | null

  @Property({ type: 'text', default: 'open' })
  status: WorkOrderStatus = 'open'

  @Property({ name: 'opened_at', type: Date, onCreate: () => new Date() })
  openedAt: Date = new Date()

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  @Property({ name: 'opened_by', type: 'uuid', nullable: true })
  openedBy?: string | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Partia robocza: jeden fizyczny pojemnik napełniany przez celę.
 *
 * To jest jednostka, w której praca robota staje się rzeczą policzalną przez
 * przedsiębiorstwo. Pojedynczy epizod to jeden chwyt - gramy. Zamówienie idzie
 * w tonach. Pojemnik jest pomostem: napełnia się godzinami, a potem staje na
 * wadze i **dopiero wtedy** wchodzi do magazynu.
 *
 * Okno czasowe pojemnika (`openedAt`..`closedAt`) jest tym, co wiąże go
 * z epizodami. Świadomie nie przypisujemy epizodów do partii polem obcym:
 * robot nie wie, do którego pojemnika trafiła sztuka, i udawanie, że wie,
 * byłoby wymyślaniem danych.
 */
@Entity({ tableName: 'work_orders_batches' })
@Index({ name: 'work_batches_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'work_batches_order_idx', properties: ['workOrderId', 'openedAt'] })
@Unique({ name: 'work_batches_container_unique', properties: ['tenantId', 'containerCode', 'openedAt'] })
export class WorkBatch {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'work_order_id', type: 'uuid' })
  workOrderId!: string

  /** Etykieta pojemnika, którą widać na hali. */
  @Property({ name: 'container_code', type: 'text' })
  containerCode!: string

  @Property({ name: 'opened_at', type: Date })
  openedAt!: Date

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  /** Masa z wagi, w gramach. Dopiero ona staje się zapasem. */
  @Property({ name: 'weighed_grams', type: 'bigint', nullable: true })
  weighedGrams?: number | null

  /** Liczba epizodów zakończonych powodzeniem w oknie partii - deklaracja robota. */
  @Property({ name: 'claimed_pieces', type: 'int', nullable: true })
  claimedPieces?: number | null

  /** Partia magazynowa założona przy zamknięciu; `null` znaczy „jeszcze nie w magazynie". */
  @Property({ name: 'lot_id', type: 'uuid', nullable: true })
  lotId?: string | null

  @Property({ name: 'lot_number', type: 'text', nullable: true })
  lotNumber?: string | null

  @Property({ type: 'text', default: 'filling' })
  status: BatchStatus = 'filling'

  @Property({ name: 'discarded_reason', type: 'text', nullable: true })
  discardedReason?: string | null

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Uzgodnienie deklaracji robota z wagą - dopisywane, nigdy nadpisywane.
 *
 * Ta tabela jest właściwym powodem istnienia całego modułu. Wszystko inne
 * (zlecenie, pojemnik, przyjęcie magazynowe) da się kupić w dowolnym systemie
 * produkcyjnym. Czego nie da się kupić, to zdanie: **„ta wersja polityki
 * zgubiła w zeszłym tygodniu 41 kg materiału, którego nie zgłosiła jako
 * porażki"**.
 *
 * Ponowne ważenie pojemnika tworzy kolejny wpis, a nie zmienia poprzedniego -
 * ta sama zasada, co w księdze ruchów magazynowych i w księdze przejść robota.
 */
@Entity({ tableName: 'work_orders_reconciliations' })
@Index({ name: 'work_recon_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'work_recon_batch_idx', properties: ['batchId', 'computedAt'] })
@Index({ name: 'work_recon_policy_idx', properties: ['tenantId', 'policyVersionId'] })
export class Reconciliation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'batch_id', type: 'uuid' })
  batchId!: string

  /** Przepisane z partii przy liczeniu, żeby werdykt dało się odtworzyć bez złączeń. */
  @Property({ name: 'policy_version_id', type: 'uuid', nullable: true })
  policyVersionId?: string | null

  @Property({ name: 'claimed_pieces', type: 'int' })
  claimedPieces!: number

  @Property({ name: 'nominal_piece_grams', type: 'int', nullable: true })
  nominalPieceGrams?: number | null

  @Property({ name: 'expected_grams', type: 'bigint', nullable: true })
  expectedGrams?: number | null

  @Property({ name: 'weighed_grams', type: 'bigint' })
  weighedGrams!: number

  /** Waga minus oczekiwanie. Ujemne znaczy: robot zgłosił więcej, niż przyniósł. */
  @Property({ name: 'drift_grams', type: 'bigint', nullable: true })
  driftGrams?: number | null

  @Property({ name: 'drift_ratio', type: 'double', nullable: true })
  driftRatio?: number | null

  @Property({ type: 'text' })
  verdict!: string

  @Property({ type: 'text' })
  reason!: string

  @Property({ name: 'tolerance_ratio', type: 'double' })
  toleranceRatio!: number

  @Property({ name: 'computed_at', type: Date, onCreate: () => new Date() })
  computedAt: Date = new Date()
}

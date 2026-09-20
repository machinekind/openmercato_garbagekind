import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Rejestr floty: co istnieje fizycznie, czym jest, gdzie stoi i czy wolno mu pracować.
 *
 * Dwie decyzje przesądzone przed pierwszą tabelą i widoczne w każdej z nich:
 *
 * 1. **Właściciel ≠ operator.** Ten sam robot bywa własnością zakładu, a
 *    obsługiwany przez integratora, który serwisuje wiele flot naraz. Platforma
 *    Open Mercato daje jedno `organization_id` na wiersz - to za mało, więc
 *    rozdzielamy `owner_organization_id` od `operator_organization_id` od
 *    początku. Dołożenie tego później dotknęłoby każdego zapytania w systemie.
 *    `organization_id` zostaje jako scope platformy (widoczność w panelu)
 *    i pokrywa się z operatorem, bo to on pracuje w interfejsie.
 *
 * 2. **Budujemy dla manipulatorów stacjonarnych.** Stąd `Cell` jest jednostką
 *    koperty bezpieczeństwa i jednostką, na poziomie której działa zatrzymanie.
 *
 * Czego tu nie ma świadomie: stanu pożądanego oprogramowania (to `deployment`),
 * telemetrii, i tożsamości kryptograficznej agenta - ta mieszka w module `edge`,
 * bo robot trwa, a klucz się rotuje.
 */

/** Stany cyklu życia robota. Kwarantanna jest stanem operacyjnym, nie serwisowym. */
export type RobotState =
  | 'registered'
  | 'commissioning'
  | 'ready'
  | 'operational'
  | 'maintenance'
  | 'quarantined'
  | 'decommissioning'
  | 'decommissioned'

@Entity({ tableName: 'fleet_sites' })
@Index({ name: 'fleet_sites_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'fleet_sites_code_unique', properties: ['tenantId', 'code'] })
export class Site {
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

  /** Strefa czasowa obiektu - raporty zmianowe liczy się lokalnie, nie w UTC. */
  @Property({ type: 'text', default: 'Europe/Warsaw' })
  timezone: string = 'Europe/Warsaw'

  @Property({ type: 'text', nullable: true })
  address?: string | null

  /**
   * Wymiary hali w metrach - obrys, na którym rysuje się cele.
   *
   * Opcjonalne, bo obiekt bez zmierzonej hali jest normalnym stanem wyjścia.
   * Brak wymiarów znaczy, że rzut składa się z samych obrysów cel, a nie że
   * hala ma zero metrów.
   */
  @Property({ name: 'floor_width_m', type: 'double', nullable: true })
  floorWidthM?: number | null

  @Property({ name: 'floor_height_m', type: 'double', nullable: true })
  floorHeightM?: number | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Cela - ograniczony obszar operacyjny z własną kopertą bezpieczeństwa.
 *
 * To jednostka, na poziomie której zatwierdza się uzasadnienie bezpieczeństwa
 * i na poziomie której działa zatrzymanie. Nie jest jednostką organizacyjną
 * platformy: jeden obiekt bywa obsługiwany przez dwa podmioty naraz.
 */
@Entity({ tableName: 'fleet_cells' })
@Index({ name: 'fleet_cells_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'fleet_cells_code_unique', properties: ['tenantId', 'siteId', 'code'] })
export class Cell {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'site_id', type: 'uuid' })
  siteId!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ type: 'text' })
  name!: string

  /**
   * Klasa celi - po niej wiąże się uzasadnienie bezpieczeństwa.
   *
   * Dwie cele tej samej klasy dzielą kopertę, więc dopuszczenie polityki
   * dotyczy klasy, nie pojedynczej celi. Bez tego każda nowa cela wymagałaby
   * osobnego uzasadnienia dla tej samej, niezmienionej konfiguracji.
   */
  @Property({ name: 'cell_class', type: 'text' })
  cellClass!: string

  /**
   * Klasa ryzyka rozstrzyga o długości dzierżawy stanu pożądanego.
   *
   * `fenced` - cela ogrodzona: dzierżawa w dniach, odcięcie chmury nie może
   * zatrzymać produkcji. `shared` - przestrzeń dzielona z ludźmi: godziny.
   * `public` - przestrzeń publiczna: minuty. To decyzja polityczna udająca
   * techniczną i dlatego jest polem, a nie stałą w kodzie.
   */
  @Property({ name: 'risk_class', type: 'text', default: 'fenced' })
  riskClass: 'fenced' | 'shared' | 'public' = 'fenced'

  /**
   * Położenie i obrys celi w metrach, względem lewego górnego rogu obiektu.
   *
   * Wszystkie cztery pola są `null`-owalne i **trzy z czterech to brak, nie
   * „prawie"**: cela bez kompletu współrzędnych nie jest rysowana na rzucie,
   * tylko trafia na listę nierozmieszczonych obok niego. Automatyczne
   * rozstawienie „gdzieś sensownie" dałoby obrazek wyglądający jak plan hali
   * i nim niebędący - a plan hali czyta się po to, żeby wiedzieć, gdzie iść.
   *
   * Obrót w stopniach, zgodnie z ruchem wskazówek zegara, bo oś Y rośnie
   * w dół (rysujemy w SVG).
   */
  @Property({ name: 'layout_x_m', type: 'double', nullable: true })
  layoutXM?: number | null

  @Property({ name: 'layout_y_m', type: 'double', nullable: true })
  layoutYM?: number | null

  @Property({ name: 'layout_width_m', type: 'double', nullable: true })
  layoutWidthM?: number | null

  @Property({ name: 'layout_height_m', type: 'double', nullable: true })
  layoutHeightM?: number | null

  @Property({ name: 'layout_rotation_deg', type: 'double', nullable: true })
  layoutRotationDeg?: number | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Kontrakt fizyczny klasy sprzętowej: co robot ma, co potrafi i w jakich granicach.
 *
 * Rewizja rośnie, gdy zmienia się **kontrakt** - inny sensor, inne limity
 * momentu - a nie gdy zmienia się kolor obudowy. Polityka wiąże się z rewizją
 * embodimentu, nie z robotem: to jedyne miejsce, w którym da się powiedzieć
 * „ta polityka fizycznie nie może działać na tym sprzęcie" *przed* wdrożeniem.
 */
@Entity({ tableName: 'fleet_embodiment_revisions' })
@Index({ name: 'fleet_embodiments_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'fleet_embodiments_key_revision_unique', properties: ['tenantId', 'embodimentKey', 'revision'] })
export class EmbodimentRevision {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'embodiment_key', type: 'text' })
  embodimentKey!: string

  @Property({ type: 'int' })
  revision!: number

  @Property({ type: 'text' })
  name!: string

  /**
   * Odcisk kontraktu: hash kanonicznej postaci przestrzeni obserwacji i akcji.
   *
   * Robot weryfikuje go lokalnie przed załadowaniem polityki i odmawia
   * uruchomienia, gdy się nie zgadza - bez pytania centrali.
   */
  @Property({ name: 'spec_digest', type: 'text' })
  specDigest!: string

  /** Liczba stopni swobody - najprostsza kontrola zdrowego rozsądku przed wdrożeniem. */
  @Property({ name: 'dof_count', type: 'int', nullable: true })
  dofCount?: number | null

  /** Pełny kontrakt: sensory, limity, kinematyka, schemat kalibracji. */
  @Property({ type: 'json', nullable: true })
  spec?: Record<string, unknown> | null

  /** Rodzaje kalibracji wymagane, żeby robot tej rewizji mógł przejść do pracy. */
  @Property({ name: 'required_calibrations', type: 'json', nullable: true })
  requiredCalibrations?: string[] | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Pojedyncza fizyczna jednostka wykonawcza.
 *
 * Tożsamością jest `(tenant_id, serial_number)` nadany przez producenta.
 * Wymiana komputera pokładowego nie tworzy nowego robota, a klucz agenta jest
 * atrybutem w module `edge`, nie tożsamością tutaj.
 */
@Entity({ tableName: 'fleet_robots' })
@Index({ name: 'fleet_robots_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'fleet_robots_owner_idx', properties: ['ownerOrganizationId', 'tenantId'] })
@Index({ name: 'fleet_robots_operator_idx', properties: ['operatorOrganizationId', 'tenantId'] })
@Index({ name: 'fleet_robots_state_idx', properties: ['tenantId', 'state'] })
@Unique({ name: 'fleet_robots_serial_unique', properties: ['tenantId', 'serialNumber'] })
export class Robot {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  /** Scope platformy - pokrywa się z operatorem, bo to on pracuje w panelu. */
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /**
   * Kto jest właścicielem maszyny.
   *
   * Rozdzielone od operatora, bo to dwie różne odpowiedzi na dwa różne pytania:
   * „czyj to sprzęt" (odpisy, ubezpieczenie, decyzja o złomowaniu) i „kto go
   * obsługuje" (dostęp do pulpitu, zlecenia serwisowe, odpowiedzialność ruchowa).
   * Zlanie ich w jedno pole jest tym błędem, którego późna korekta dotyka
   * każdego zapytania w systemie.
   */
  @Property({ name: 'owner_organization_id', type: 'uuid' })
  ownerOrganizationId!: string

  /** Kto go obsługuje. Bywa integratorem serwisującym wiele flot. */
  @Property({ name: 'operator_organization_id', type: 'uuid' })
  operatorOrganizationId!: string

  @Property({ name: 'serial_number', type: 'text' })
  serialNumber!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'embodiment_revision_id', type: 'uuid' })
  embodimentRevisionId!: string

  @Property({ name: 'cell_id', type: 'uuid', nullable: true })
  cellId?: string | null

  @Property({ type: 'text', default: 'registered' })
  state: RobotState = 'registered'

  /**
   * Powód ostatniego przejścia stanu.
   *
   * Przy kwarantannie to jedyna rzecz, którą operator zobaczy najpierw -
   * i jedyna, która pozwala odróżnić wygaśnięcie kalibracji od incydentu.
   */
  @Property({ name: 'state_reason', type: 'text', nullable: true })
  stateReason?: string | null

  @Property({ name: 'state_changed_at', type: Date, nullable: true })
  stateChangedAt?: Date | null

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
 * Zmierzone parametry wiążące konkretny egzemplarz z kontraktem jego embodimentu.
 *
 * Kalibracja jest **warunkiem dopuszczenia polityki**, a nie zadaniem
 * serwisowym - dlatego mieszka tutaj, a nie w module konserwacji. Wygaśnięcie
 * degraduje robota, nawet gdy mechanicznie jest w pełni sprawny.
 */
@Entity({ tableName: 'fleet_calibrations' })
@Index({ name: 'fleet_calibrations_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'fleet_calibrations_robot_idx', properties: ['robotId', 'kind', 'measuredAt'] })
@Unique({ name: 'fleet_calibrations_measurement_unique', properties: ['robotId', 'kind', 'measuredAt'] })
export class Calibration {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  /** Rodzaj pomiaru: `camera_extrinsics`, `joint_offsets`, `tool_center_point`… */
  @Property({ type: 'text' })
  kind!: string

  @Property({ name: 'measured_at', type: Date })
  measuredAt!: Date

  /**
   * Do kiedy pomiar jest ważny.
   *
   * Pole obowiązkowe celowo: kalibracja bez daty ważności jest kalibracją,
   * o której nikt nigdy nie przypomni, a robot z przeterminowanym pomiarem
   * wygląda w każdym zestawieniu identycznie jak sprawny.
   */
  @Property({ name: 'valid_until', type: Date })
  validUntil!: Date

  /** Niepewność pomiaru - bez niej „skalibrowany" jest słowem, nie liczbą. */
  @Property({ type: 'json', nullable: true })
  uncertainty?: Record<string, unknown> | null

  @Property({ type: 'json', nullable: true })
  values?: Record<string, unknown> | null

  @Property({ name: 'measured_by', type: 'uuid', nullable: true })
  measuredBy?: string | null

  /** Unieważnienie ręczne - np. po uderzeniu w robota, przed terminem. */
  @Property({ name: 'invalidated_at', type: Date, nullable: true })
  invalidatedAt?: Date | null

  @Property({ name: 'invalidated_reason', type: 'text', nullable: true })
  invalidatedReason?: string | null

  /**
   * Odhaczenie powiadomienia o wygaśnięciu - nie status ważności.
   *
   * Ważność wyprowadzamy przy odczycie z `validUntil` i tak zostaje: kolumna
   * „wygasła true/false" psuje się dokładnie wtedy, gdy przestanie działać
   * proces, który ją ustawia. To pole odpowiada na inne pytanie - „czy ten
   * konkretny fakt został już raz ogłoszony". Bez niego detektor cykliczny
   * nadawałby to samo zdarzenie co przebieg i po dobie nikt by go już nie
   * czytał.
   */
  @Property({ name: 'expiry_notified_at', type: Date, nullable: true })
  expiryNotifiedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Księga przejść stanu robota - dopisywana, nigdy nadpisywana.
 *
 * Ta sama zasada, co w księdze ruchów magazynowych sortowni: poprawka jest
 * kolejnym wpisem, nie zmianą poprzedniego. Tam chroniła bilans masy; tutaj
 * chroni odpowiedź na pytanie „dlaczego ten robot stał trzy dni w kwarantannie".
 */
@Entity({ tableName: 'fleet_robot_transitions' })
@Index({ name: 'fleet_transitions_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'fleet_transitions_robot_idx', properties: ['robotId', 'occurredAt'] })
export class RobotTransition {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'robot_id', type: 'uuid' })
  robotId!: string

  @Property({ name: 'from_state', type: 'text', nullable: true })
  fromState?: RobotState | null

  @Property({ name: 'to_state', type: 'text' })
  toState!: RobotState

  @Property({ type: 'text' })
  reason!: string

  /** Kto wywołał przejście; `null` oznacza system (np. wygaśnięcie kalibracji). */
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'occurred_at', type: Date, onCreate: () => new Date() })
  occurredAt: Date = new Date()

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null
}

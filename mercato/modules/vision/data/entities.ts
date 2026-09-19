import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Wzrok maszynowy jako **trzeci świadek**, nie jako strumień wideo.
 *
 * Decyzja, która przesądza o kształcie wszystkich czterech tabel: **ta
 * platforma nie przechowuje klatek**. Detekcja dzieje się przy kamerze,
 * a tu trafia policzony wynik. Trzy powody, każdy wystarczający osobno:
 *
 * 1. **Przepustowość i opóźnienie.** Pięć cel po 30 klatek na sekundę to
 *    strumień, którego system ewidencyjny nie ma po co dotykać.
 * 2. **Brak GPU i brak powodu, żeby go mieć.** Wnioskowanie należy do brzegu.
 * 3. **Prawo.** Nagranie z hali to dane osobowe. Art. 22² § 1 Kodeksu pracy
 *    dopuszcza monitoring wyłącznie w zamkniętym katalogu celów (bezpieczeństwo
 *    pracowników, ochrona mienia, **kontrola produkcji**, zachowanie tajemnicy)
 *    i nakazuje zniszczenie nagrań po **3 miesiącach**. ERP, który wciąga
 *    surowe wideo, dziedziczy obowiązek, do którego nie jest zbudowany.
 *
 * Co w zamian: rejestr kamer z zadeklarowanym celem ustawowym, rejestr
 * detektorów z progiem ufności, **okna zliczeń** zamiast pojedynczych detekcji,
 * i materiał dowodowy wyłącznie przez odniesienie, z obowiązkowym terminem
 * usunięcia.
 */

export type CountingMode = 'tracks' | 'detections'
export type CameraPurpose = 'safety' | 'property' | 'production_control' | 'trade_secret'

/**
 * Kamera obserwująca celę.
 *
 * Kamera jest cechą **celi**, nie robota — to domyka lukę wskazaną przy
 * SO-101: polityka wytrenowana z dwiema kamerami nie ruszy na stanowisku
 * z jedną, a liczba i rozmieszczenie kamer nie należą do ramienia.
 */
@Entity({ tableName: 'vision_cameras' })
@Index({ name: 'vision_cameras_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'vision_cameras_cell_idx', properties: ['tenantId', 'cellId'] })
@Unique({ name: 'vision_cameras_code_unique', properties: ['tenantId', 'code'] })
export class Camera {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'cell_id', type: 'uuid' })
  cellId!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ type: 'text' })
  name!: string

  /** Gdzie patrzy: `belt_infeed`, `gripper_wrist`, `bin_outfeed`, `cell_overview`. */
  @Property({ name: 'view_role', type: 'text' })
  viewRole!: string

  /**
   * Cel ustawowy z zamkniętego katalogu art. 22² § 1 Kodeksu pracy.
   *
   * Pole obowiązkowe i bez wartości domyślnej. Kamera bez zadeklarowanego celu
   * jest kamerą, której podstawy prawnej nikt nie potrafi wskazać w dniu
   * kontroli — a katalog jest zamknięty, więc „inne" nie istnieje.
   */
  @Property({ type: 'text' })
  purpose!: CameraPurpose

  /**
   * Ile dni wolno trzymać materiał z tej kamery.
   *
   * Górna granica to 90 dni (art. 22² § 3 KP: zniszczenie po 3 miesiącach,
   * chyba że nagranie stanowi dowód w postępowaniu). Wartość jest polem,
   * a nie stałą, bo dla kamery patrzącej wyłącznie na taśmę bez ludzi
   * uzasadniony bywa okres krótszy — a krótszy zawsze wolno.
   */
  @Property({ name: 'retention_days', type: 'int' })
  retentionDays!: number

  /**
   * Czy w polu widzenia bywają ludzie.
   *
   * Rozstrzyga o tym, czy w ogóle wolno zapisać materiał dowodowy i jak długo.
   * Deklaracja, nie wykrycie — bo „nigdy nie ma tam ludzi" jest twierdzeniem
   * organizacyjnym, za które odpowiada pracodawca, a nie detektorem.
   */
  @Property({ name: 'people_in_view', type: 'boolean', default: true })
  peopleInView: boolean = true

  /** Data poinformowania załogi — art. 22² § 7 KP, dwa tygodnie przed uruchomieniem. */
  @Property({ name: 'workforce_notified_at', type: Date, nullable: true })
  workforceNotifiedAt?: Date | null

  /** Data oznaczenia obszaru — art. 22² § 9 KP, najpóźniej dzień przed. */
  @Property({ name: 'area_marked_at', type: Date, nullable: true })
  areaMarkedAt?: Date | null

  @Property({ name: 'resolution', type: 'text', nullable: true })
  resolution?: string | null

  @Property({ name: 'frames_per_second', type: 'int', nullable: true })
  framesPerSecond?: number | null

  @Property({ type: 'text', default: 'active' })
  status: 'active' | 'disabled' = 'active'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Wersja detektora: co potrafi rozpoznać, z jakim progiem i czym jest.
 *
 * Osobno od `policy_registry`, bo detektor nie jest sterownikiem: nie porusza
 * maszyną, nie wiąże się z rewizją embodimentu i nie przechodzi przez bramę
 * dopuszczenia ruchowego. Wiąże się natomiast z **kamerą i sceną**, a to jest
 * inna oś niż sprzęt wykonawczy.
 */
@Entity({ tableName: 'vision_detector_versions' })
@Index({ name: 'vision_detectors_scope_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'vision_detectors_key_revision_unique', properties: ['tenantId', 'detectorKey', 'revision'] })
export class DetectorVersion {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'detector_key', type: 'text' })
  detectorKey!: string

  @Property({ type: 'int' })
  revision!: number

  @Property({ type: 'text' })
  name!: string

  /** Skrót wag — tożsamość wersji, liczona z pliku, nie deklarowana. */
  @Property({ name: 'weights_digest', type: 'text' })
  weightsDigest!: string

  /**
   * Słownik klas, które detektor potrafi zwrócić.
   *
   * Sprawdzany przy rejestracji przeciw zakazom art. 5 aktu o sztucznej
   * inteligencji. Detektor deklarujący klasy emocjonalne albo kategoryzację
   * biometryczną nie da się zarejestrować — i to jest odmowa, nie ostrzeżenie.
   */
  @Property({ name: 'class_vocabulary', type: 'json' })
  classVocabulary!: string[]

  /**
   * Próg ufności, przy którym policzono zliczenia.
   *
   * Pole obowiązkowe, bo **liczba bez progu nie jest pomiarem**. Ten sam
   * strumień przy progu 0,3 i 0,7 daje dwie różne liczby obiektów i obie są
   * „prawdziwe". Ta sama zasada, co przy kalibracji bez daty ważności.
   */
  @Property({ name: 'confidence_threshold', type: 'double' })
  confidenceThreshold!: number

  @Property({ name: 'input_resolution', type: 'text', nullable: true })
  inputResolution?: string | null

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Okno zliczeń — policzony wynik z przedziału czasu, nie pojedyncza detekcja.
 *
 * Kamera 30 fps przez ośmiogodzinną zmianę daje 864 tysiące klatek. Wiersz na
 * detekcję byłby tabelą, której nikt nigdy nie odpyta. Brzeg agreguje do okien
 * (minuta, zmiana) i przysyła zliczenia per klasa.
 *
 * `framesAnalyzed` jest tu równie ważne jak same zliczenia: okno policzone
 * z dwunastu klatek i okno policzone z tysiąca ośmiuset wyglądają identycznie
 * w kolumnie „liczba obiektów", a znaczą co innego.
 */
@Entity({ tableName: 'vision_detection_windows' })
@Index({ name: 'vision_windows_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'vision_windows_camera_idx', properties: ['cameraId', 'startedAt'] })
@Index({ name: 'vision_windows_cell_idx', properties: ['tenantId', 'cellId', 'startedAt'] })
@Unique({ name: 'vision_windows_unique', properties: ['cameraId', 'startedAt', 'detectorVersionId'] })
export class DetectionWindow {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'camera_id', type: 'uuid' })
  cameraId!: string

  @Property({ name: 'cell_id', type: 'uuid' })
  cellId!: string

  @Property({ name: 'detector_version_id', type: 'uuid' })
  detectorVersionId!: string

  @Property({ name: 'started_at', type: Date })
  startedAt!: Date

  @Property({ name: 'ended_at', type: Date })
  endedAt!: Date

  @Property({ name: 'frames_analyzed', type: 'int' })
  framesAnalyzed!: number

  /**
   * Czy liczono **ścieżki** czy **detekcje**.
   *
   * To jest różnica między „przejechało 1000 butelek" a „butelki widziano
   * 30 000 razy". Butelka widoczna w trzydziestu klatkach to jeden obiekt,
   * nie trzydzieści. Brzeg musi powiedzieć, co przysyła, bo zliczenia detekcji
   * podane jako zliczenia obiektów zamieniają całą triangulację w bełkot.
   */
  @Property({ name: 'counting_mode', type: 'text' })
  countingMode!: CountingMode

  /** `{ "pet": 1000, "pvc": 41, "person": 2 }` — klasa → liczba. */
  @Property({ type: 'json' })
  counts!: Record<string, number>

  /** Średnia ufność per klasa, gdy brzeg ją liczy. */
  @Property({ name: 'mean_confidence', type: 'json', nullable: true })
  meanConfidence?: Record<string, number> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Materiał dowodowy — **wyłącznie przez odniesienie**.
 *
 * W bazie leży adres i termin usunięcia, nigdy bajty. Termin jest polem
 * obowiązkowym i liczonym przy zapisie, bo art. 22² § 3 Kodeksu pracy nakazuje
 * zniszczenie nagrania po trzech miesiącach. Klip bez terminu to klip,
 * który zostanie na dysku na zawsze i wyjdzie przy kontroli.
 */
@Entity({ tableName: 'vision_clips' })
@Index({ name: 'vision_clips_scope_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'vision_clips_purge_idx', properties: ['tenantId', 'deleteAfter', 'markedForDeletionAt'] })
export class Clip {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'camera_id', type: 'uuid' })
  cameraId!: string

  /** Do czego się odnosi: epizod, incydent, partia robocza. */
  @Property({ name: 'subject_type', type: 'text' })
  subjectType!: string

  @Property({ name: 'subject_id', type: 'uuid', nullable: true })
  subjectId?: string | null

  /** Adres w magazynie obiektów. Bajty nigdy nie przechodzą przez tę bazę. */
  @Property({ type: 'text' })
  uri!: string

  @Property({ name: 'recorded_at', type: Date })
  recordedAt!: Date

  @Property({ name: 'duration_seconds', type: 'int' })
  durationSeconds!: number

  /** Termin usunięcia — liczony z `retention_days` kamery, nie przyjmowany od wołającego. */
  @Property({ name: 'delete_after', type: Date })
  deleteAfter!: Date

  /**
   * Moment oznaczenia do usunięcia — **nie** moment usunięcia.
   *
   * Rozdział wprowadzony, gdy zadanie cykliczne zaczęło oznaczać klipy
   * automatycznie. Poprzednia nazwa (`purgedAt`) sugerowała, że plik zniknął,
   * a platforma nigdy go nie kasuje: bajty leżą w magazynie obiektów, do
   * którego ERP nie ma dostępu. Zautomatyzowanie samego oznaczania dałoby
   * **zautomatyzowaną księgowość zamiast zgodności** — i nikt by tego nie
   * zauważył, bo kolumna nazywałaby się „purged".
   */
  @Property({ name: 'marked_for_deletion_at', type: Date, nullable: true })
  markedForDeletionAt?: Date | null

  /**
   * Potwierdzenie usunięcia bajtów przez tego, kto je trzyma.
   *
   * Dopóki to pole jest puste przy wypełnionym `markedForDeletionAt`, materiał
   * **nadal istnieje po ustawowym terminie**. To jest właściwa liczba
   * zgodności — i to ona ma być widoczna, a nie liczba oznaczeń.
   */
  @Property({ name: 'deletion_confirmed_at', type: Date, nullable: true })
  deletionConfirmedAt?: Date | null

  @Property({ name: 'deletion_confirmed_by', type: 'text', nullable: true })
  deletionConfirmedBy?: string | null

  /**
   * Wstrzymanie usunięcia, gdy nagranie jest dowodem w postępowaniu.
   *
   * Jedyny przewidziany w ustawie wyjątek od terminu — i dlatego wymaga
   * podania sygnatury, a nie samego zaznaczenia pola.
   */
  @Property({ name: 'legal_hold_reference', type: 'text', nullable: true })
  legalHoldReference?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

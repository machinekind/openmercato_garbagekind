import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia modułu wizji.
 *
 * Ciężar jest tu przesunięty w stronę zgodności, i to nie z ostrożności,
 * tylko z rachunku ryzyka: błąd w zliczaniu obiektów kosztuje jedną złą
 * liczbę w raporcie, a błąd w obchodzeniu się z nagraniem ludzi na stanowisku
 * pracy kosztuje postępowanie. Dlatego `camera.compliance_warning`
 * i `clips.deletion_overdue` są tu pełnoprawnymi zdarzeniami, a nie wpisami
 * w logu.
 *
 * `clips.deletion_overdue` jest jedynym zdarzeniem w całej wtyczce, które
 * celowo **powtarza się** przy każdym przebiegu, dopóki stan trwa. To nie jest
 * wyjątek od zasady wyzwalania zboczem - to inna klasa faktu: „dziś nadal
 * przechowujemy nagranie po ustawowym terminie" jest prawdziwe każdego dnia
 * z osobna i każdego dnia z osobna jest naruszeniem.
 */

const events = [
  {
    id: 'vision.camera.registered',
    label: 'Zarejestrowano kamerę',
    entity: 'camera',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator kamery' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'cellId', type: 'text' },
        { path: 'code', type: 'text' },
        { path: 'purpose', type: 'select', label: 'Cel z zamkniętego katalogu art. 22² KP' },
        { path: 'retentionDays', type: 'number' },
        { path: 'peopleInView', type: 'boolean' },
      ],
    },
  },
  {
    id: 'vision.camera.compliance_warning',
    label: 'Kamera zarejestrowana z brakami formalnymi',
    description: 'Braki usuwalne przed uruchomieniem: nieuprzedzona załoga, nieoznaczony obszar. Kamera istnieje, ale nie powinna jeszcze nagrywać.',
    entity: 'camera',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator kamery' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'code', type: 'text' },
        { path: 'warnings', type: 'object', label: 'Lista braków do usunięcia' },
      ],
    },
  },
  {
    id: 'vision.detector.registered',
    label: 'Zarejestrowano wersję detektora',
    entity: 'detector_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji detektora' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'detectorKey', type: 'text' },
        { path: 'revision', type: 'number' },
        { path: 'weightsDigest', type: 'text' },
        { path: 'presenceOnly', type: 'boolean', label: 'Czy słownik pozwala wyłącznie na stwierdzenie obecności osoby' },
      ],
    },
  },
  {
    id: 'vision.window.recorded',
    label: 'Zapisano okno detekcji',
    description: 'Zliczenia z jednej kamery za jeden przedział. Zdarzenie o częstotliwości minutowej na kamerę - do tablic i zliczeń, nie do alarmów.',
    entity: 'detection_window',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator okna' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'cameraId', type: 'text' },
        { path: 'cellId', type: 'text' },
        { path: 'detectorVersionId', type: 'text' },
        { path: 'startedAt', type: 'date' },
        { path: 'endedAt', type: 'date' },
        { path: 'counts', type: 'object', label: 'Zliczenia wg klas' },
        { path: 'countingMode', type: 'select', label: 'tracks | detections' },
      ],
    },
  },
  {
    id: 'vision.clips.marked_for_deletion',
    label: 'Oznaczono materiał do usunięcia',
    description: 'Termin z art. 22² § 3 KP upłynął. Oznaczenie nie jest usunięciem - bajty kasuje ten, kto je trzyma.',
    entity: 'clip',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'markedCount', type: 'number' },
        { path: 'heldBack', type: 'number', label: 'Wstrzymane jako dowód w postępowaniu' },
        { path: 'clipIds', type: 'object' },
      ],
    },
  },
  {
    id: 'vision.clips.deletion_confirmed',
    label: 'Potwierdzono usunięcie materiału',
    description: 'Dopiero to zamyka zgodność. Potwierdzenia odrzucone oznaczają materiał skasowany poza procesem.',
    entity: 'clip',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'confirmed', type: 'number' },
        { path: 'rejected', type: 'object', label: 'Klipy, których nikt wcześniej nie oznaczył' },
        { path: 'confirmedBy', type: 'text' },
      ],
    },
  },
  {
    id: 'vision.clips.deletion_overdue',
    label: 'Materiał po terminie nadal nieusunięty',
    description: 'Oznaczony i niepotwierdzony. Z punktu widzenia przepisu nagranie wciąż tam jest. Powtarzane przy każdym przebiegu, dopóki stan trwa.',
    entity: 'clip',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'unconfirmed', type: 'number', label: 'Liczba nagrań oznaczonych i nieusuniętych' },
        { path: 'oldestMarkedAt', type: 'date', optional: true, label: 'Od kiedy najstarsze z nich czeka' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'vision',
  events,
})

export const emitVisionEvent = eventsConfig.emit
export type VisionEventId = typeof events[number]['id']

export default eventsConfig

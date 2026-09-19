import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia rejestru floty.
 *
 * Zasada doboru: deklarujemy wyłącznie te fakty, na które inny podsystem ma
 * prawo zareagować — i wyłącznie te, które faktycznie emitujemy. Zdarzenie
 * zadeklarowane, a nigdy nieemitowane, jest gorsze niż jego brak: pojawia się
 * na liście wyzwalaczy workflow i ktoś zbuduje na nim automatyzację, która
 * nigdy nie zadziała, a zawiedzie dopiero w dniu, w którym miała zadziałać.
 *
 * Dlatego nie ma tu lustrzanego odbicia CRUD dla każdej encji. Dziennik audytu
 * szyny komend już zapisuje każdy zapis z aktorem i snapshotem — zdarzenia
 * odpowiadają na inne pytanie: „co musi się teraz stać gdzie indziej".
 */

const SCOPE_FIELDS = [
  { path: 'id', type: 'text' as const, label: 'Identyfikator robota' },
  { path: 'organizationId', type: 'text' as const, optional: true },
  { path: 'tenantId', type: 'text' as const, optional: true },
]

const events = [
  {
    id: 'fleet.robot.registered',
    label: 'Robot zarejestrowany',
    description: 'Nowa maszyna weszła do rejestru. Nie jest jeszcze dopuszczona do pracy.',
    entity: 'robot',
    category: 'crud',
    payloadSchema: {
      fields: [
        ...SCOPE_FIELDS,
        { path: 'serialNumber', type: 'text', label: 'Numer seryjny' },
        { path: 'name', type: 'text' },
        { path: 'embodimentRevisionId', type: 'text' },
        { path: 'ownerOrganizationId', type: 'text' },
        { path: 'operatorOrganizationId', type: 'text' },
        { path: 'cellId', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'fleet.robot.transitioned',
    label: 'Robot zmienił stan',
    description: 'Każde przejście w cyklu życia maszyny, razem ze stanem wyjściowym i aktorem.',
    entity: 'robot',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        ...SCOPE_FIELDS,
        { path: 'fromState', type: 'text', label: 'Stan poprzedni' },
        { path: 'toState', type: 'text', label: 'Stan docelowy' },
        { path: 'reason', type: 'text' },
        { path: 'actor', type: 'select', label: 'human albo system' },
        { path: 'approvedBy', type: 'text', optional: true },
      ],
    },
  },
  {
    /**
     * Osobne zdarzenie obok `transitioned` — nie jest to duplikat przez pomyłkę.
     * Subskrybent, który ma wstrzymać przydział pracy maszynie, nie powinien
     * dopasowywać stringa w polu `toState`. Ten sam wzorzec ma rdzeń: `wms`
     * emituje i `inventory_balance.updated`, i `inventory.low_stock`.
     */
    id: 'fleet.robot.quarantined',
    label: 'Robot w kwarantannie',
    description: 'Maszyna wycofana z eksploatacji. Nie wolno jej przydzielać pracy do czasu podpisanego dopuszczenia.',
    entity: 'robot',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        ...SCOPE_FIELDS,
        { path: 'fromState', type: 'text' },
        { path: 'reason', type: 'text' },
        { path: 'actor', type: 'select' },
      ],
    },
  },
  {
    id: 'fleet.robot.cleared',
    label: 'Robot dopuszczony do pracy',
    description: 'Maszyna weszła w stan `ready`. Zawsze z podpisem człowieka — automat nie dopuszcza.',
    entity: 'robot',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        ...SCOPE_FIELDS,
        { path: 'fromState', type: 'text' },
        { path: 'reason', type: 'text' },
        { path: 'approvedBy', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'fleet.robot.decommissioned',
    label: 'Robot wycofany',
    description: 'Stan końcowy. Tożsamość agenta brzegowego tej maszyny musi zostać trwale unieważniona.',
    entity: 'robot',
    category: 'lifecycle',
    payloadSchema: {
      fields: [...SCOPE_FIELDS, { path: 'fromState', type: 'text' }, { path: 'reason', type: 'text' }],
    },
  },
  {
    id: 'fleet.calibration.recorded',
    label: 'Kalibracja zapisana',
    entity: 'calibration',
    category: 'crud',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator kalibracji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'kind', type: 'text' },
        { path: 'measuredAt', type: 'date' },
        { path: 'validUntil', type: 'date' },
      ],
    },
  },
  {
    /**
     * Wygaśnięcie kalibracji jest faktem wyprowadzanym przy odczycie (patrz
     * `lib/calibration.ts`) i tak zostaje — ale wyprowadzenie przy odczycie
     * nikogo nie budzi. To zdarzenie emituje detektor cykliczny, raz na
     * kalibrację, z odhaczeniem w kolumnie `expiry_notified_at`. Bez tego
     * odhaczenia ten sam fakt wracałby co przebieg i przestałby cokolwiek
     * znaczyć.
     */
    id: 'fleet.calibration.expired',
    label: 'Kalibracja wygasła',
    description: 'Pomiar stracił ważność. Robot wygląda w każdym zestawieniu tak samo jak sprawny — dopóki ktoś nie zareaguje.',
    entity: 'calibration',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator kalibracji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'kind', type: 'text' },
        { path: 'validUntil', type: 'date' },
        { path: 'robotState', type: 'text', label: 'Stan robota w chwili wykrycia' },
        { path: 'required', type: 'boolean', label: 'Czy rewizja embodimentu wymaga tej kalibracji' },
      ],
    },
  },
  {
    id: 'fleet.cell.layout_changed',
    label: 'Zmieniono rozmieszczenie celi',
    description: 'Geometria celi na rzucie hali uległa zmianie.',
    entity: 'cell',
    category: 'custom',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator celi' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'x', type: 'number' },
        { path: 'y', type: 'number' },
        { path: 'width', type: 'number' },
        { path: 'height', type: 'number' },
        { path: 'rotationDeg', type: 'number', optional: true },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'fleet',
  events,
})

export const emitFleetEvent = eventsConfig.emit
export type FleetEventId = typeof events[number]['id']

export default eventsConfig

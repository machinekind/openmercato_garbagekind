import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia mostu hala ↔ ERP.
 *
 * Najważniejsze jest `batch.drift_detected` i warto powiedzieć wprost, czego
 * ono **nie** znaczy. Rozjazd między masą zważoną a masą wynikającą ze zgłoszeń
 * robota nie wstrzymuje materiału: masa idzie na stan taka, jaka wyszła z wagi,
 * bo waga jest jedynym przyrządem pomiarowym w tym łańcuchu. Rozjazd jest oceną
 * **maszyny**, nie towaru. Zdarzenie służy do skierowania kogoś do robota,
 * a nie do zatrzymania partii.
 *
 * `batch.closed` niesie werdykt zawsze, także `ok` — bo odbiorca budujący
 * statystykę dryfu potrzebuje mianownika, nie tylko licznika.
 */

const events = [
  {
    id: 'work_orders.order.opened',
    label: 'Otwarto zlecenie robocze',
    entity: 'work_order',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zlecenia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'orderNumber', type: 'text' },
        { path: 'cellId', type: 'text' },
        { path: 'sku', type: 'text' },
        { path: 'targetGrams', type: 'number' },
        { path: 'policyVersionId', type: 'text', optional: true },
        { path: 'salesOrderId', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'work_orders.order.closed',
    label: 'Zamknięto zlecenie robocze',
    entity: 'work_order',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zlecenia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'status', type: 'text' },
        { path: 'producedGrams', type: 'number', label: 'Masa faktycznie zważona' },
        { path: 'batches', type: 'number' },
      ],
    },
  },
  {
    id: 'work_orders.batch.opened',
    label: 'Otwarto partię',
    entity: 'work_batch',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator partii' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'workOrderId', type: 'text' },
        { path: 'containerCode', type: 'text' },
        { path: 'openedAt', type: 'date' },
      ],
    },
  },
  {
    id: 'work_orders.batch.closed',
    label: 'Zamknięto i zważono partię',
    description: 'Werdykt uzgodnienia jedzie w ładunku zawsze, także gdy brzmi `ok` — statystyka dryfu potrzebuje mianownika.',
    entity: 'work_batch',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator partii' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'workOrderId', type: 'text' },
        { path: 'weighedGrams', type: 'number', label: 'Masa z wagi — ta idzie na stan' },
        { path: 'claimedPieces', type: 'number', label: 'Sztuki zgłoszone przez robota' },
        { path: 'expectedGrams', type: 'number' },
        { path: 'driftGrams', type: 'number' },
        { path: 'verdict', type: 'select', label: 'ok | overclaim | underclaim | no_reference' },
        { path: 'lotNumber', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'work_orders.batch.drift_detected',
    label: 'Rozjazd masy zgłoszonej i zważonej',
    description: 'Ocena maszyny, nie towaru. Materiał idzie na stan wg wagi — to zdarzenie kieruje człowieka do robota.',
    entity: 'reconciliation',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator partii' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'workOrderId', type: 'text' },
        { path: 'policyVersionId', type: 'text', optional: true },
        { path: 'weighedGrams', type: 'number' },
        { path: 'expectedGrams', type: 'number' },
        { path: 'driftGrams', type: 'number' },
        { path: 'driftRatio', type: 'number' },
        { path: 'verdict', type: 'select', label: 'overclaim | underclaim | no_reference' },
        { path: 'reason', type: 'text' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'work_orders',
  events,
})

export const emitWorkOrdersEvent = eventsConfig.emit
export type WorkOrdersEventId = typeof events[number]['id']

export default eventsConfig

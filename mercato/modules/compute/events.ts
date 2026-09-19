import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia ewidencji zasobów obliczeniowych.
 *
 * Dwa zdarzenia, nie więcej, i to jest adekwatne do tego, czym ten moduł jest:
 * ewidencją sprzętu i tym, co na nim stoi. Nie ma tu zdarzenia na odmowę
 * przypisania roli bezpieczeństwa, choć kusi — odmowa jest wyjątkiem komendy
 * i wraca do wołającego natychmiast, a próba, która się nie powiodła, nie
 * zmieniła stanu świata. Dziennik audytu szyny komend zapisuje ją razem
 * z aktorem i tam jest jej miejsce.
 */

const events = [
  {
    id: 'compute.node.registered',
    label: 'Zarejestrowano węzeł obliczeniowy',
    entity: 'compute_node',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator węzła' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'code', type: 'text' },
        { path: 'kind', type: 'text' },
        { path: 'cellId', type: 'text', optional: true },
        { path: 'memoryGb', type: 'number' },
        { path: 'memoryBandwidthGbs', type: 'number', label: 'Przepustowość pamięci — liczba rozstrzygająca o przepustowości dekodowania' },
        { path: 'roles', type: 'object' },
        { path: 'realtimeCapable', type: 'boolean' },
      ],
    },
  },
  {
    id: 'compute.placement.set',
    label: 'Przypisano zadanie do węzła',
    entity: 'placement',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przypisania' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'nodeId', type: 'text' },
        { path: 'workloadType', type: 'select', label: 'training_run | detector_version | policy_version | simulation' },
        { path: 'workloadRef', type: 'text' },
        { path: 'requiredRole', type: 'text' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'compute',
  events,
})

export const emitComputeEvent = eventsConfig.emit
export type ComputeEventId = typeof events[number]['id']

export default eventsConfig

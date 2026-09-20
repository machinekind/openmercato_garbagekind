import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia rejestru polityk.
 *
 * Najważniejsze jest `version.released` i nie jest to to samo co
 * `version.registered`: zarejestrowanie wersji znaczy „komplet artefaktów
 * leży na półce", a zwolnienie - „wolno to wgrać na maszynę". Dwa różne
 * fakty, dwaj różni odbiorcy. Zlanie ich w jedno zdarzenie „wersja zmieniła
 * status" kazałoby każdemu subskrybentowi dopasowywać string.
 */

const events = [
  {
    id: 'policy_registry.policy.registered',
    label: 'Polityka zarejestrowana',
    entity: 'policy',
    category: 'crud',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator polityki' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyKey', type: 'text' },
        { path: 'name', type: 'text' },
      ],
    },
  },
  {
    id: 'policy_registry.version.registered',
    label: 'Wersja polityki zarejestrowana',
    description: 'Komplet artefaktów przyjęty. Nie znaczy jeszcze, że wolno go wgrać na maszynę.',
    entity: 'policy_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyId', type: 'text' },
        { path: 'version', type: 'number' },
        { path: 'contentDigest', type: 'text', label: 'Odcisk treści artefaktów' },
        { path: 'embodimentRevisionId', type: 'text' },
        { path: 'declaredSpecDigest', type: 'text' },
      ],
    },
  },
  {
    id: 'policy_registry.version.transitioned',
    label: 'Wersja polityki zmieniła status',
    entity: 'policy_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'fromStatus', type: 'text' },
        { path: 'toStatus', type: 'text' },
        { path: 'reason', type: 'text' },
      ],
    },
  },
  {
    id: 'policy_registry.version.released',
    label: 'Wersja polityki zwolniona do użycia',
    description: 'Od tej chwili wolno przypisać tę wersję maszynie.',
    entity: 'policy_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'fromStatus', type: 'text' },
        { path: 'reason', type: 'text' },
      ],
    },
  },
  {
    id: 'policy_registry.version.deprecated',
    label: 'Wersja polityki wycofana',
    description: 'Wersja nie powinna być dalej przypisywana. Maszyny, które ją mają, wymagają decyzji.',
    entity: 'policy_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'fromStatus', type: 'text' },
        { path: 'reason', type: 'text' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'policy_registry',
  events,
})

export const emitPolicyRegistryEvent = eventsConfig.emit
export type PolicyRegistryEventId = typeof events[number]['id']

export default eventsConfig

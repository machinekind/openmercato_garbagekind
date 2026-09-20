import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia wdrożeń etapowych.
 *
 * Werdykt bramy jest tu jedynym faktem, który naprawdę musi wyjść poza moduł,
 * i dlatego ma trzy zdarzenia zamiast jednego z polem `decision`. Powód jest
 * praktyczny: odbiorca „wycofano wdrożenie" to zwykle dyżurny albo kanał
 * alarmowy, a odbiorca „etap przeszedł dalej" to tablica postępu. Zlanie ich
 * w jedno zdarzenie kazałoby kanałowi alarmowemu filtrować po stringu -
 * i odpalać się przy każdym pomyślnym przejściu, dopóki ktoś tego filtru nie
 * napisze poprawnie.
 *
 * `gate.held` nie jest wersją porażki: wstrzymanie znaczy, że dowodów jest
 * za mało, żeby zdecydować. To jest osobna informacja i mylenie jej z porażką
 * popycha ludzi do przepychania wdrożeń przez bramę, która nic jeszcze nie
 * powiedziała.
 */

const STAGE_FIELDS = [
  { path: 'id', type: 'text' as const, label: 'Identyfikator etapu' },
  { path: 'organizationId', type: 'text' as const, optional: true },
  { path: 'tenantId', type: 'text' as const, optional: true },
  { path: 'rolloutId', type: 'text' as const },
]

const events = [
  {
    id: 'rollout.rollout.planned',
    label: 'Zaplanowano wdrożenie',
    entity: 'rollout',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wdrożenia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'name', type: 'text' },
        { path: 'policyVersionId', type: 'text' },
        { path: 'mode', type: 'select', label: 'shadow | active' },
        { path: 'stageCount', type: 'number' },
      ],
    },
  },
  {
    id: 'rollout.stage.started',
    label: 'Etap wdrożenia ruszył',
    description: 'Ładunek niesie także liczbę maszyn pominiętych - etap, w którym pominięto połowę floty, wygląda w statusie tak samo jak udany.',
    entity: 'stage',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        ...STAGE_FIELDS,
        { path: 'applied', type: 'number', label: 'Maszyn objętych' },
        { path: 'skipped', type: 'number', label: 'Maszyn pominiętych' },
      ],
    },
  },
  {
    id: 'rollout.gate.advanced',
    label: 'Brama przepuściła etap',
    entity: 'stage',
    category: 'lifecycle',
    payloadSchema: {
      fields: [...STAGE_FIELDS, { path: 'reason', type: 'text' }, { path: 'measured', type: 'object' }],
    },
  },
  {
    id: 'rollout.gate.held',
    label: 'Brama wstrzymała etap',
    description: 'Za mało dowodów, żeby zdecydować. To nie jest porażka.',
    entity: 'stage',
    category: 'lifecycle',
    payloadSchema: {
      fields: [...STAGE_FIELDS, { path: 'reason', type: 'text' }, { path: 'measured', type: 'object' }],
    },
  },
  {
    id: 'rollout.gate.rolled_back',
    label: 'Brama wycofała wdrożenie',
    description: 'Maszyny wróciły na poprzednią politykę, dalsze etapy wstrzymano.',
    entity: 'stage',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        ...STAGE_FIELDS,
        { path: 'reason', type: 'text' },
        { path: 'measured', type: 'object' },
        { path: 'haltedStages', type: 'number' },
        { path: 'rolledBackRobots', type: 'number' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'rollout',
  events,
})

export const emitRolloutEvent = eventsConfig.emit
export type RolloutEventId = typeof events[number]['id']

export default eventsConfig

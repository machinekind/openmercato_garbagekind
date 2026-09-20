import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia warstwy bezpieczeństwa.
 *
 * Jedna nieobecność wymaga uzasadnienia: **nie ma zdarzenia na sprawdzenie
 * dopuszczenia** (`safety.clearance.check`). Ta komenda jest pytaniem, nie
 * faktem - wołają ją bramki przed każdym przypisaniem, a odmowa jest jej
 * normalną odpowiedzią, nie zdarzeniem w świecie. Zdarzenie na odczyt
 * generowałoby strumień proporcjonalny do liczby sprawdzeń i mówiło o tym,
 * jak często pytamy, a nie o tym, co się stało.
 *
 * Rozdział `case.withdrawn` od `incident.halted_deployment` też jest celowy.
 * Człowiek wycofujący uzasadnienie i incydent wycofujący je hurtem dla całej
 * klasy celi to dwa różne zdarzenia w organizacji, choć w bazie skutkują tą
 * samą zmianą statusu.
 */

const events = [
  {
    id: 'safety.case.drafted',
    label: 'Uzasadnienie bezpieczeństwa utworzone',
    entity: 'safety_case',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator uzasadnienia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyVersionId', type: 'text' },
        { path: 'cellClass', type: 'text' },
        { path: 'riskClass', type: 'select', label: 'fenced | shared | public' },
      ],
    },
  },
  {
    id: 'safety.case.approved',
    label: 'Uzasadnienie bezpieczeństwa zatwierdzone',
    description: 'Od tej chwili wersja polityki ma dopuszczenie w tej klasie celi - do daty ważności, nie bezterminowo.',
    entity: 'safety_case',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator uzasadnienia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'approvedBy', type: 'text' },
        { path: 'validUntil', type: 'date' },
        { path: 'safetyLayerKind', type: 'text', label: 'Rodzaj deterministycznej warstwy bezpieczeństwa' },
      ],
    },
  },
  {
    id: 'safety.case.withdrawn',
    label: 'Uzasadnienie bezpieczeństwa wycofane',
    description: 'Wycofanie decyzją człowieka. Wersja traci dopuszczenie w tej klasie celi.',
    entity: 'safety_case',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator uzasadnienia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'reason', type: 'text' },
        { path: 'previousStatus', type: 'text' },
      ],
    },
  },
  {
    id: 'safety.suite.defined',
    label: 'Zdefiniowano zestaw ewaluacyjny',
    entity: 'eval_suite',
    category: 'crud',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zestawu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'suiteKey', type: 'text' },
        { path: 'requiredFor', type: 'object', label: 'Klasy ryzyka, dla których zestaw jest obowiązkowy' },
      ],
    },
  },
  {
    id: 'safety.run.recorded',
    label: 'Zapisano przebieg ewaluacyjny',
    entity: 'eval_run',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przebiegu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyVersionId', type: 'text' },
        { path: 'suiteKey', type: 'text' },
        { path: 'result', type: 'select', label: 'pass | fail | error' },
        { path: 'passedCases', type: 'number', optional: true },
        { path: 'totalCases', type: 'number', optional: true },
        { path: 'embodimentSpecDigest', type: 'text', optional: true },
      ],
    },
  },
  {
    /**
     * `error` idzie tu razem z `fail` i to nie jest niedbałość. Zestaw, który
     * się wywrócił, **nie wykazał** zgodności - tak samo jak zestaw oblany.
     * Rozdzielenie ich zachęcałoby do traktowania awarii potoku jako „jeszcze
     * nie porażka", a to jest dokładnie ten nawyk, który kończy się polityką
     * dopuszczoną bez dowodu.
     */
    id: 'safety.run.failed',
    label: 'Przebieg ewaluacyjny nie wykazał zgodności',
    description: 'Wynik `fail` albo `error`. Awaria potoku nie jest łagodniejsza niż oblany zestaw - w obu wypadkach dowodu nie ma.',
    entity: 'eval_run',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przebiegu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyVersionId', type: 'text' },
        { path: 'suiteKey', type: 'text' },
        { path: 'result', type: 'select', label: 'fail | error' },
        { path: 'evidenceUri', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'safety.incident.reported',
    label: 'Zgłoszono zdarzenie bezpieczeństwa',
    entity: 'incident',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zdarzenia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text', optional: true },
        { path: 'cellId', type: 'text', optional: true },
        { path: 'policyVersionId', type: 'text', optional: true },
        { path: 'episodeId', type: 'text', optional: true },
        { path: 'harm', type: 'select', label: 'none | near_miss | first_aid | lost_time | serious' },
        { path: 'priority', type: 'text' },
        { path: 'haltDeployment', type: 'boolean' },
        { path: 'safetyLayerEngaged', type: 'boolean' },
        { path: 'policyImplicated', type: 'boolean' },
        { path: 'reason', type: 'text' },
        { path: 'occurredAt', type: 'date' },
      ],
    },
  },
  {
    id: 'safety.incident.halted_deployment',
    label: 'Zdarzenie wycofało dopuszczenie dla klasy celi',
    description: 'Wycofanie hurtowe: dopuszczenie dotyczy klasy celi, więc zdarzenie je podważające podważa je dla wszystkich cel tej klasy.',
    entity: 'incident',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zdarzenia' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'policyVersionId', type: 'text' },
        { path: 'cellClass', type: 'text' },
        { path: 'priority', type: 'text' },
        { path: 'reason', type: 'text' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'safety',
  events,
})

export const emitSafetyEvent = eventsConfig.emit
export type SafetyEventId = typeof events[number]['id']

export default eventsConfig

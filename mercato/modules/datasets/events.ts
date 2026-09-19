import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia zamykające pętlę uczenia.
 *
 * `version.built` niesie ostrzeżenia o składzie, a nie sam rozmiar zbioru.
 * Powód: wersja zbudowana z samych udanych epizodów wygląda w liczniku
 * identycznie jak zbiór zrównoważony i jest bezużyteczna do uczenia
 * odzyskiwania po błędzie. Odbiorca, który dostaje tylko `episodeCount`,
 * nie ma jak tego zobaczyć.
 *
 * `run.completed` jest jedynym miejscem, gdzie powstaje wiązanie wersja
 * zbioru ↔ wersja polityki, więc jego ładunek niesie oba identyfikatory —
 * to jedyny punkt, w którym pętla domyka się w danych.
 */

const events = [
  {
    id: 'datasets.dataset.defined',
    label: 'Zdefiniowano zbiór',
    entity: 'dataset',
    category: 'crud',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator zbioru' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'datasetKey', type: 'text' },
        { path: 'taskKey', type: 'text' },
        { path: 'embodimentKey', type: 'text' },
      ],
    },
  },
  {
    id: 'datasets.version.built',
    label: 'Zbudowano wersję zbioru',
    entity: 'dataset_version',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator wersji zbioru' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'datasetId', type: 'text' },
        { path: 'version', type: 'number' },
        { path: 'contentDigest', type: 'text' },
        { path: 'episodeCount', type: 'number' },
        { path: 'warnings', type: 'object', label: 'Ostrzeżenia o składzie zbioru' },
      ],
    },
  },
  {
    id: 'datasets.run.registered',
    label: 'Zarejestrowano przebieg treningowy',
    entity: 'training_run',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przebiegu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'datasetVersionId', type: 'text' },
        { path: 'runRef', type: 'text' },
        { path: 'framework', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'datasets.run.completed',
    label: 'Przebieg treningowy domknięty',
    description: 'Moment, w którym powstaje wiązanie wersja zbioru ↔ wersja polityki. Pętla zamyka się tutaj albo nigdzie.',
    entity: 'training_run',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przebiegu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'runRef', type: 'text' },
        { path: 'status', type: 'select', label: 'succeeded | failed' },
        { path: 'datasetVersionId', type: 'text' },
        { path: 'policyVersionId', type: 'text', optional: true },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'datasets',
  events,
})

export const emitDatasetsEvent = eventsConfig.emit
export type DatasetsEventId = typeof events[number]['id']

export default eventsConfig

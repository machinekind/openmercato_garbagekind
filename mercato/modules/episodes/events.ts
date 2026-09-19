import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia dziennika epizodów.
 *
 * Epizody przychodzą hurtem z hali, więc `episode.recorded` jest zdarzeniem
 * o wysokiej częstotliwości i świadomie ma płaski ładunek — służy zliczaniu
 * i zasilaniu tablic, nie podejmowaniu decyzji. Decyzje wiszą na dwóch
 * pozostałych.
 *
 * `intervention.recorded` jest tu faktem najcenniejszym: człowiek musiał
 * wejść między maszynę a zadanie. To jedyna miara, która nie daje się
 * podrobić optymalizacją metryki — bo kosztuje czyjś czas na hali.
 *
 * `intervention.emergency` wydzielone osobno, bo zatrzymanie awaryjne
 * i przejęcie zdalne to nie jest ta sama klasa faktu co korekta chwytu.
 * Odbiorca alarmowy nie powinien tego rozróżniać dopasowaniem stringa
 * w polu `kind`.
 */

const events = [
  {
    id: 'episodes.episode.recorded',
    label: 'Epizod zapisany',
    description: 'Pojedyncze wykonanie zadania przez maszynę. Zdarzenie o wysokiej częstotliwości — do zliczeń, nie do alarmów.',
    entity: 'episode',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator epizodu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'sequence', type: 'number' },
        { path: 'taskKey', type: 'text' },
        { path: 'outcome', type: 'select', label: 'success | failure | aborted | timeout' },
        { path: 'durationMs', type: 'number' },
        { path: 'policyVersionId', type: 'text', optional: true },
        { path: 'cellId', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'episodes.intervention.recorded',
    label: 'Interwencja człowieka',
    description: 'Człowiek wszedł między maszynę a zadanie. Miara, której nie da się podrobić optymalizacją metryki.',
    entity: 'intervention',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator interwencji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'episodeId', type: 'text', optional: true },
        { path: 'kind', type: 'select', label: 'adjust | manual_reset | teleop_takeover | abort | estop' },
        { path: 'reasonCategory', type: 'text' },
        { path: 'reason', type: 'text' },
        { path: 'occurredAt', type: 'date' },
        { path: 'recoverySeconds', type: 'number', optional: true },
      ],
    },
  },
  {
    id: 'episodes.intervention.emergency',
    label: 'Interwencja awaryjna',
    description: 'Zatrzymanie awaryjne albo przejęcie zdalne. Inna klasa faktu niż korekta chwytu.',
    entity: 'intervention',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator interwencji' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'episodeId', type: 'text', optional: true },
        { path: 'kind', type: 'select', label: 'estop | abort | teleop_takeover' },
        { path: 'reasonCategory', type: 'text' },
        { path: 'reason', type: 'text' },
        { path: 'occurredAt', type: 'date' },
      ],
    },
  },
  {
    id: 'episodes.counts.corrected',
    label: 'Poprawiono liczniki interwencji',
    description: 'Denormalizowany licznik rozjechał się z tabelą interwencji i został wyrównany. Rozjazd zwykle znaczy, że gdzieś zapis poszedł obok komendy.',
    entity: 'episode',
    category: 'system',
    payloadSchema: {
      fields: [
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'checked', type: 'number' },
        { path: 'corrected', type: 'number' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'episodes',
  events,
})

export const emitEpisodesEvent = eventsConfig.emit
export type EpisodesEventId = typeof events[number]['id']

export default eventsConfig

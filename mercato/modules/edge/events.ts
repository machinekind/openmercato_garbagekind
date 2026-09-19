import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia warstwy brzegowej.
 *
 * Dobór jest tu bardziej restrykcyjny niż gdzie indziej, bo ten moduł jako
 * jedyny obsługuje ruch o częstotliwości maszynowej. Świadomie **nie ma**
 * zdarzenia na uderzenie serca: przy flocie kilkudziesięciu maszyn nadających
 * co sekundę byłby to strumień, który zatapia szynę i w którym nikt nigdy nie
 * zobaczy zdarzenia naprawdę istotnego. Uderzenie serca jest ruchem, nie
 * faktem — faktem jest dopiero jego **brak**.
 *
 * Granica modułu zostaje nienaruszona: `edge` stwierdza ciszę i ogłasza ją.
 * Wniosek, że cisza znaczy „nie wolno pracować", należy do dziedziny i zapada
 * w `fleet` — tutaj nie ma i nie będzie zmiany stanu robota.
 */

const events = [
  {
    id: 'edge.enrollment.issued',
    label: 'Wydano bilet przyłączenia',
    description: 'Wystawiono jednorazowy bilet, którym maszyna przyłączy własną tożsamość. Fakt istotny dla bezpieczeństwa: bilet jest poświadczeniem.',
    entity: 'enrollment_token',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator biletu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'expiresAt', type: 'date' },
        { path: 'issuedBy', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'edge.agent.enrolled',
    label: 'Agent przyłączony',
    description: 'Maszyna przyłączyła własną tożsamość — klucz publiczny jest odtąd znany centrali.',
    entity: 'agent',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator agenta' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'sessionId', type: 'text' },
        { path: 'fingerprint', type: 'text', label: 'Odcisk klucza publicznego' },
        { path: 'agentVersion', type: 'text', optional: true },
      ],
    },
  },
  {
    id: 'edge.agent.connected',
    label: 'Agent połączony',
    description: 'Otwarto nową sesję. Normalny skutek restartu maszyny albo odtworzenia łączności.',
    entity: 'agent',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator agenta' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'sessionId', type: 'text' },
        { path: 'supersededSessionId', type: 'text', optional: true },
        { path: 'agentVersion', type: 'text', optional: true },
      ],
    },
  },
  {
    /**
     * Nazwa mówi „podejrzenie", nie „wykrycie", i to nie jest ostrożność
     * językowa. Wyparcie otwartej sesji robi tak samo zwykły restart maszyny,
     * jak i druga kopia agenta z tym samym kluczem. Pojedyncze zdarzenie nie
     * rozstrzyga niczego — rozstrzyga dopiero ciąg wyparć w krótkim czasie,
     * i dlatego ładunek niesie czas życia wypartej sesji oraz liczbę jej
     * uderzeń serca. Zdarzenie o nazwie `clone_detected` kazałoby odbiorcy
     * uwierzyć w pewność, której nie mamy.
     */
    id: 'edge.agent.clone_suspected',
    label: 'Podejrzenie klonu agenta',
    description: 'Nowa sesja wyparła sesję wciąż żywą. Tak wygląda restart — i tak samo wygląda druga kopia agenta z tym samym kluczem.',
    entity: 'agent',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator agenta' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'sessionId', type: 'text', label: 'Sesja nowa' },
        { path: 'supersededSessionId', type: 'text', label: 'Sesja wyparta' },
        { path: 'supersededHeartbeatCount', type: 'number', label: 'Ile uderzeń serca zdążyła nadać wyparta sesja' },
        { path: 'supersededSilenceSeconds', type: 'number', optional: true, label: 'Cisza wypartej sesji w chwili wyparcia' },
      ],
    },
  },
  {
    /**
     * Najważniejsze zdarzenie tego modułu: maszyna przestała się odzywać.
     * Nie ma go skąd wziąć inaczej niż z zamiatania, bo brak zdarzenia z
     * definicji nie generuje zdarzenia — musi go ogłosić ktoś, kto patrzy
     * na zegar.
     */
    id: 'edge.agent.lost',
    label: 'Agent utracony',
    description: 'Cisza przekroczyła próg odcięcia i sesja została zamknięta. Moduł brzegowy nie zmienia z tego powodu stanu robota.',
    entity: 'agent',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator agenta' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'sessionId', type: 'text' },
        { path: 'silenceSeconds', type: 'number', optional: true, label: 'Ile trwała cisza' },
      ],
    },
  },
  {
    id: 'edge.agent.key_rotated',
    label: 'Wymieniono klucz agenta',
    description: 'Nowy klucz jest aktywny, stary pozostaje ważny przez okno zakładki, aż dotrze na maszynę.',
    entity: 'agent_key',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator nowego klucza' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'agentId', type: 'text' },
        { path: 'fingerprint', type: 'text' },
        { path: 'retiredKeyIds', type: 'object', label: 'Klucze wygaszane po oknie zakładki' },
        { path: 'overlapUntil', type: 'date' },
      ],
    },
  },
  {
    id: 'edge.agent.revoked',
    label: 'Agent odwołany',
    description: 'Tożsamość unieważniona natychmiast, bez okna zakładki. Wszystkie klucze i sesje zamknięte.',
    entity: 'agent',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator agenta' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'reason', type: 'text' },
        { path: 'revokedKeys', type: 'number' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'edge',
  events,
})

export const emitEdgeEvent = eventsConfig.emit
export type EdgeEventId = typeof events[number]['id']

export default eventsConfig

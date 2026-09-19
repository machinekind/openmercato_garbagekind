import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Zdarzenia warstwy wdrożenia.
 *
 * Dwie świadome nieobecności:
 *
 * 1. **Nie ma zdarzenia na wydanie dzierżawy.** Dzierżawa jest odnawiana przez
 *    każdą maszynę co kilkadziesiąt sekund; zdarzenie na każdą z nich byłoby
 *    strumieniem o częstotliwości maszynowej, w którym utonęłoby wszystko
 *    inne. Wydanie dzierżawy jest ruchem, nie faktem.
 *
 * 2. **Nie ma zdarzenia na raport stanu.** Z tego samego powodu. Faktem nie
 *    jest raport, tylko **zmiana werdyktu**: chwila, w której maszyna rozjeżdża
 *    się ze stanem pożądanym, i chwila, w której wraca. Dlatego oba zdarzenia
 *    niżej są wyzwalane zboczem — porównaniem z poprzednim raportem tej samej
 *    maszyny, a nie samym faktem nadejścia raportu. Bez tego „rozjazd" wracałby
 *    co kilkadziesiąt sekund przez cały czas jego trwania i przestałby cokolwiek
 *    znaczyć.
 */

const events = [
  {
    id: 'deployment.assignment.assigned',
    label: 'Przypisano politykę maszynie',
    entity: 'assignment',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przypisania' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'policyVersionId', type: 'text' },
        { path: 'desiredState', type: 'select' },
        { path: 'riskClass', type: 'text' },
        { path: 'leaseSeconds', type: 'number' },
        { path: 'supersededId', type: 'text', optional: true },
        { path: 'reason', type: 'text' },
      ],
    },
  },
  {
    id: 'deployment.assignment.revoked',
    label: 'Odwołano przypisanie polityki',
    description: 'Odwołanie skraca czas, do którego sięga łącze. Nie jest zatrzymaniem maszyny — to należy do deterministycznej warstwy bezpieczeństwa.',
    entity: 'assignment',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator przypisania' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'reason', type: 'text' },
        { path: 'revokedLeases', type: 'number' },
      ],
    },
  },
  {
    id: 'deployment.state.drift_detected',
    label: 'Maszyna rozjechała się ze stanem pożądanym',
    description: 'Pierwszy raport rozjazdu po okresie zgodności. Kolejne raporty tego samego rozjazdu nie są ogłaszane.',
    entity: 'state_report',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator raportu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'assignmentId', type: 'text', optional: true },
        { path: 'reportedState', type: 'select' },
        { path: 'reportedPolicyVersionId', type: 'text', optional: true },
        { path: 'reason', type: 'text' },
        { path: 'previousReconciliation', type: 'text', optional: true, label: 'Werdykt poprzedniego raportu' },
      ],
    },
  },
  {
    id: 'deployment.state.converged',
    label: 'Maszyna wróciła do stanu pożądanego',
    description: 'Domknięcie rozjazdu. Bez tego zdarzenia odbiorca wiedziałby, kiedy się zepsuło, i nigdy — kiedy naprawiło.',
    entity: 'state_report',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text', label: 'Identyfikator raportu' },
        { path: 'organizationId', type: 'text', optional: true },
        { path: 'tenantId', type: 'text', optional: true },
        { path: 'robotId', type: 'text' },
        { path: 'assignmentId', type: 'text', optional: true },
        { path: 'reportedState', type: 'select' },
        { path: 'previousReconciliation', type: 'text', optional: true },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'deployment',
  events,
})

export const emitDeploymentEvent = eventsConfig.emit
export type DeploymentEventId = typeof events[number]['id']

export default eventsConfig

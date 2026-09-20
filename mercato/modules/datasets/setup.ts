import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * `employee` widzi i buduje zbiory, ale nie zamyka pętli.
 *
 * Zamknięcie pętli - deklaracja „ta polityka wyszła z tego zbioru" - jest
 * zapisem, od którego zależy każda późniejsza diagnoza regresu. Zbiór zbudowany
 * przypadkiem da się odbudować; wiązanie wpisane przypadkiem kłamie cicho.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['datasets.*'],
    employee: ['datasets.view', 'datasets.build'],
  },
}

export default setup

import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * `employee` dostaje podgląd i **odwoływanie**, ale nie przypisywanie.
 *
 * Asymetria jest zamierzona i jest tą samą asymetrią, co w cyklu życia robota:
 * zatrzymać wolno szeroko, dopuścić - wąsko. Operator na hali ma móc zdjąć
 * politykę z maszyny bez szukania kogokolwiek; wprowadzenie nowej wymaga
 * uprawnienia, którego domyślnie nie ma.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['deployment.*'],
    employee: ['deployment.view', 'deployment.revoke'],
  },
}

export default setup

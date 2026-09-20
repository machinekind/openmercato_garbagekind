import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Pracownik hali waży pojemniki - to jest jego robota i blokowanie jej
 * wydłużyłoby tylko drogę materiału do magazynu. Zakładanie zleceń zostaje
 * przy administratorze, bo zlecenie wiąże celę z zamówieniem sprzedaży,
 * a to jest decyzja planistyczna, nie ruchowa.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['work_orders.*'],
    employee: ['work_orders.view', 'work_orders.weigh'],
  },
}

export default setup

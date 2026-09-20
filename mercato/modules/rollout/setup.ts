import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * `employee` widzi wdrożenia i może je **zatrzymać**, ale nie zaplanować
 * ani nie uruchomić etapu. Ta sama asymetria, co przy stanie pożądanym
 * i przy cyklu życia robota: zatrzymać wolno szeroko, wypuścić - wąsko.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['rollout.*'],
    employee: ['rollout.view', 'rollout.halt'],
  },
}

export default setup

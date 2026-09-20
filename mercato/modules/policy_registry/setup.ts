import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Domyślne nadanie uprawnień rolom.
 *
 * `employee` dostaje podgląd i rejestrowanie, ale **nie** wypuszczanie:
 * wgranie wag jest czynnością techniczną, wypuszczenie ich na flotę - decyzją
 * o dopuszczeniu maszyny do ruchu. Zlanie obu w jedno uprawnienie kasuje
 * jedyny moment, w którym ktoś musi się pod tym podpisać.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`. Sam
 * `defaultRoleFeatures` nie zostanie zauważony i uprawnienia po cichu nie powstaną.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['policy_registry.*'],
    employee: ['policy_registry.view', 'policy_registry.manage'],
  },
}

export default setup

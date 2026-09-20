import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Kto widzi pulpit i kto może uruchomić import.
 *
 * Brygadzista ma widzieć zapełnienie boksów bez prawa do ruszania integracji -
 * stąd rozdzielone uprawnienia.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['sortownia.*'],
    employee: ['sortownia.view'],
  },
}

export default setup

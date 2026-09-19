import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['digital_twins.view'],
    employee: ['digital_twins.view'],
  },
}

export default setup

import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['physical_management.*'],
    employee: ['physical_management.view'],
  },
}

export default setup

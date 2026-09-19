import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Nobody gets `robotics.bridge.report` by default: it belongs to the API key
 * the bridge process runs under, not to a human role.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['robotics.*'],
    admin: ['robotics.cells.*', 'robotics.tasks.*'],
    employee: ['robotics.cells.view', 'robotics.tasks.view', 'robotics.tasks.operate'],
  },
}

export default setup

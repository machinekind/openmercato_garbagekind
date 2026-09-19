import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createPickTaskService } from './lib/pickTaskService'

/** DI token this module owns. Exported so routes, CLI and tests name it once. */
export const ROBOTICS_PICK_TASK_SERVICE = 'roboticsPickTaskService' as const

export function register(container: AppContainer) {
  // `.scoped()`: the service closes over the request container's `em`, and with
  // it that request's tenant. A singleton would pin the first caller's tenant
  // for the life of the process.
  container.register({
    [ROBOTICS_PICK_TASK_SERVICE]: asFunction(createPickTaskService).scoped(),
  })
}

import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * `clientBroadcast` puts these on the admin SSE bridge, so an operator watching
 * the tasks page sees the arm's progress without polling.
 */
const events = [
  { id: 'robotics.pick_task.queued', label: 'Pick task queued', entity: 'pick_task', category: 'crud', clientBroadcast: true },
  { id: 'robotics.pick_task.claimed', label: 'Pick task claimed', entity: 'pick_task', category: 'lifecycle', clientBroadcast: true },
  { id: 'robotics.pick_task.progress', label: 'Pick task progress', entity: 'pick_task', category: 'lifecycle', clientBroadcast: true },
  { id: 'robotics.pick_task.finished', label: 'Pick task finished', entity: 'pick_task', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'robotics', events })
export const emitRoboticsEvent = eventsConfig.emit

export default eventsConfig

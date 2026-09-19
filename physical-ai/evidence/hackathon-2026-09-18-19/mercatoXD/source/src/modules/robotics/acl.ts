/**
 * RBAC features for the robotics module.
 *
 * `operate` is deliberately separate from `manage`: queueing a pick task moves
 * a physical arm, so the right to create work is not the right to edit a cell's
 * connection settings, and neither implies the other.
 */
export const features = [
  { id: 'robotics.cells.view', title: 'View robot cells', module: 'robotics' },
  {
    id: 'robotics.cells.manage',
    title: 'Manage robot cells',
    module: 'robotics',
    dependsOn: ['robotics.cells.view'],
  },
  { id: 'robotics.tasks.view', title: 'View pick tasks', module: 'robotics' },
  {
    id: 'robotics.tasks.operate',
    title: 'Queue and abort pick tasks',
    module: 'robotics',
    dependsOn: ['robotics.tasks.view'],
  },
  {
    id: 'robotics.bridge.report',
    title: 'Claim and report pick tasks (robot bridge)',
    module: 'robotics',
    dependsOn: ['robotics.tasks.view'],
  },
]

export default features

export const metadata = {
  requireAuth: true,
  requireFeatures: ['physical_management.view'],
  pageTitle: 'Physical Management',
  pageTitleKey: 'physical_management.panel.title',
  pageGroup: 'Physical AI',
  pageGroupKey: 'physical_management.nav.group',
  pageOrder: 1,
  icon: 'map',
  breadcrumb: [{ label: 'Physical AI', labelKey: 'physical_management.nav.group' }],
} as const

export const metadata = {
  requireAuth: true,
  requireFeatures: ['fleet.view'],
  pageTitle: 'Robot',
  pageTitleKey: 'fleet.detail.title',
  breadcrumb: [
    { label: 'Flota', labelKey: 'fleet.nav.group', href: '/backend/fleet' },
    { label: 'Robot', labelKey: 'fleet.detail.title' },
  ],
} as const

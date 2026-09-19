import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'

/**
 * Kafelek dopuszczeń bezpieczeństwa.
 *
 * Jedyna liczba na pulpicie, której **rosnąca wartość jest zła**: liczba
 * uzasadnień deklarujących uczoną politykę jako funkcję bezpieczeństwa.
 * W zdrowym systemie jest zerem i ma nim zostać — każda inna wartość
 * oznacza dokument, który w postępowaniu przed organem nadzoru zaszkodzi
 * bardziej niż jego brak.
 */

export type SafetyClearanceSettings = Record<string, never>

const SafetyClearanceWidget = lazyDashboardWidget<SafetyClearanceSettings>(() => import('./widget.client'))

/*
 * Tytuł i opis w metadanych zostają po angielsku, bo platforma nie
 * przepuszcza ich przez tłumacza — tak samo trzyma je każdy widget rdzenia.
 * Treść widgetu jest tłumaczona normalnie, przez `useT`.
 */
const widget: DashboardWidgetModule<SafetyClearanceSettings> = {
  metadata: {
    id: 'safety.dashboard.clearance',
    title: 'Safety clearances',
    description: 'How many policy × cell-class pairs are cleared, how many blocked, and whether anyone declares a policy as a safety function.',
    features: ['dashboards.view', 'safety.view'],
    defaultSize: 'sm',
    defaultEnabled: false,
    defaultSettings: {},
    tags: ['safety', 'compliance', 'robotics'],
    category: 'compliance',
    icon: 'shield',
    supportsRefresh: true,
  },
  Widget: SafetyClearanceWidget,
}

export default widget

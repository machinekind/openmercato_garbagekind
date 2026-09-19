import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'

/**
 * Kafelek gotowości floty na pulpicie głównym.
 *
 * Powód istnienia: dotąd odpowiedź na pytanie „ile maszyn wolno dziś
 * uruchomić" wymagała wejścia na osobny ekran. Człowiek, który otwiera
 * rano pulpit, nie szuka rejestru floty — i właśnie dlatego nie zobaczy
 * kwarantanny, dopóki ktoś mu o niej nie powie.
 */

export type FleetReadinessSettings = Record<string, never>

const FleetReadinessWidget = lazyDashboardWidget<FleetReadinessSettings>(() => import('./widget.client'))

/*
 * Tytuł i opis w metadanych zostają po angielsku, bo platforma nie
 * przepuszcza ich przez tłumacza — tak samo trzyma je każdy widget rdzenia.
 * Treść widgetu jest tłumaczona normalnie, przez `useT`.
 */
const widget: DashboardWidgetModule<FleetReadinessSettings> = {
  metadata: {
    id: 'fleet.dashboard.readiness',
    title: 'Fleet readiness',
    description: 'How many machines are cleared to run, how many sit in quarantine, and what blocks the rest.',
    features: ['dashboards.view', 'fleet.view'],
    defaultSize: 'md',
    // Domyślnie wyłączony: instalacja bez robotów miałaby na pulpicie
    // kafelek pokazujący same zera, a to uczy ludzi go nie czytać.
    defaultEnabled: false,
    defaultSettings: {},
    tags: ['fleet', 'robotics'],
    category: 'operations',
    icon: 'bot',
    supportsRefresh: true,
  },
  Widget: FleetReadinessWidget,
}

export default widget

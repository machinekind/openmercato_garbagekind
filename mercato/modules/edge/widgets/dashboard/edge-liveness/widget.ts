import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'

/**
 * Kafelek łączności agentów.
 *
 * Odpowiada na inne pytanie niż kafelek gotowości floty: tamten mówi, czy
 * maszynie **wolno** pracować, ten — czy centrala **w ogóle wie**, co się
 * z nią dzieje. Utracona łączność wygląda w rejestrze floty tak samo jak
 * maszyna sprawna, bo rejestr nie ma skąd wiedzieć.
 */

export type EdgeLivenessSettings = Record<string, never>

const EdgeLivenessWidget = lazyDashboardWidget<EdgeLivenessSettings>(() => import('./widget.client'))

/*
 * Tytuł i opis w metadanych zostają po angielsku, bo platforma nie
 * przepuszcza ich przez tłumacza — tak samo trzyma je każdy widget rdzenia.
 * Treść widgetu jest tłumaczona normalnie, przez `useT`.
 */
const widget: DashboardWidgetModule<EdgeLivenessSettings> = {
  metadata: {
    id: 'edge.dashboard.liveness',
    title: 'Agent link',
    description: 'Who is reporting in, who is silent, and since when. Silence here is information, not missing data.',
    features: ['dashboards.view', 'edge.view'],
    defaultSize: 'sm',
    defaultEnabled: false,
    defaultSettings: {},
    tags: ['edge', 'robotics'],
    category: 'operations',
    icon: 'radio',
    supportsRefresh: true,
  },
  Widget: EdgeLivenessWidget,
}

export default widget

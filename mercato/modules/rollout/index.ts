import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'rollout',
  title: 'Wdrożenia etapowe',
  version: '0.1.0',
  description:
    'Wdrożenie wersji polityki na flotę etapami, z bramą opartą na liczbach z księgi epizodów i automatycznym wycofaniem.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Wdrożenie etapowe jest spięciem trzech wcześniejszych modułów i nie wnosi
   * własnej wiedzy o robocie, polityce ani epizodzie: `fleet` daje populację,
   * `policy_registry` - co wdrażamy, `episodes` - liczby dla bramy,
   * `deployment` - kanał, którym zmiana dociera do maszyny.
   *
   * Kierunek jest jednostronny. Gdyby `deployment` zaczął wiedzieć o etapach,
   * stan pożądany przestałby dać się ustawić bez wdrożenia - a ręczne
   * przypisanie polityki jednemu robotowi jest normalną czynnością serwisową.
   */
  requires: ['fleet', 'policy_registry', 'deployment', 'episodes'],
  ejectable: true,
}

export { features } from './acl'

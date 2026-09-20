import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'episodes',
  title: 'Epizody i interwencje',
  version: '0.1.0',
  description:
    'Księga epizodów jako atomów pracy oraz interwencji człowieka jako obiektu pierwszorzędnego.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * `fleet` bo epizod dzieje się na robocie w celi. `policy_registry` bo
   * kadencja autonomii liczona jest per wersja polityki i bez tego wiązania
   * raport nie miałby o czym mówić.
   *
   * Świadomie NIE ma tu `deployment`: epizod przeprowadzony ręcznie albo
   * teleoperacyjnie też jest epizodem i musi wejść do księgi. Wymaganie
   * przypisania wykluczyłoby dokładnie te przypadki, w których autonomii
   * nie było - czyli zawyżyłoby ją tam, gdzie najbardziej kusi.
   */
  requires: ['fleet', 'policy_registry'],
  ejectable: true,
}

export { features } from './acl'

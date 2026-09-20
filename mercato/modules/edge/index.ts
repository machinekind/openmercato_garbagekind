import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'edge',
  title: 'Kanał brzegowy',
  version: '0.1.0',
  description: 'Tożsamość kryptograficzna agenta, sesje łączności i podpisany kanał telemetrii.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Zależność jest jednostronna i taka ma zostać: agent bez robota nie ma
   * sensu, robot bez agenta owszem - flota inwentaryzowana ręcznie to
   * najczęstszy punkt wyjścia każdego wdrożenia.
   */
  requires: ['fleet', 'episodes', 'vision'],
  ejectable: true,
}

export { features } from './acl'

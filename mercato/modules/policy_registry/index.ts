import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'policy_registry',
  title: 'Rejestr polityk',
  version: '0.1.0',
  description:
    'Wersjonowany rejestr wyuczonych sterowników i ich artefaktów, wiązany z rewizją embodimentu.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Zależność jednostronna: rejestr polityk czyta rewizje embodimentu z `fleet`,
   * bo to tam mieszka kontrakt fizyczny. Odwrotnie nie - rejestr floty działa
   * bez jednej zarejestrowanej polityki i tak ma zostać (flota istnieje przed
   * pierwszym modelem i po ostatnim).
   */
  requires: ['fleet'],
  ejectable: true,
}

export { features } from './acl'

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'physical_management',
  title: 'Physical Management',
  version: '0.1.0',
  description:
    'Digital twin budynku łączący rejestr obiektu, źródła wideo i anonimowe dane o ruchu ludzi.',
  author: 'machinekind',
  license: 'MIT',
  requires: ['fleet', 'vision', 'hmi'],
  ejectable: true,
}

export { features } from './acl'

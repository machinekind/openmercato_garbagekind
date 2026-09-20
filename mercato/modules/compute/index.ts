import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'compute',
  title: 'Węzły obliczeniowe',
  version: '0.1.0',
  description: 'Rejestr zdolności obliczeniowych i przypisań - z zakazem pełnienia funkcji bezpieczeństwa.',
  author: 'machinekind',
  license: 'MIT',
  /** Węzeł bywa przypisany do celi, ale nie zależy od niczego innego. */
  requires: ['fleet'],
  ejectable: true,
}

export { features } from './acl'

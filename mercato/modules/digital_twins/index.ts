import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'digital_twins',
  title: 'Digital twins',
  version: '0.2.0',
  description: 'Authenticated room twin with camera management and anonymous worker tracking.',
  author: 'machinekind',
  license: 'MIT',
  requires: [],
  ejectable: true,
}

export { features } from './acl'

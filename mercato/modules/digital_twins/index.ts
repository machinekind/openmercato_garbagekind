import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'digital_twins',
  title: 'Digital twins',
  version: '0.1.0',
  description: 'Authenticated geometric room viewer from LiDAR and video references.',
  author: 'machinekind',
  license: 'MIT',
  requires: [],
  ejectable: true,
}

export { features } from './acl'

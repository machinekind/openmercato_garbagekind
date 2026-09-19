import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'hmi',
  title: 'System wizualny HMI',
  version: '0.1.0',
  description: 'Żetony, słownik stanów i elementy ekranów operatorskich — norma szara, kolor wyłącznie dla odstępstwa.',
  author: 'machinekind',
  license: 'MIT',
  /** Nic nie wymaga: to warstwa prezentacji bez własnych danych. */
  requires: [],
  ejectable: true,
}

export { features } from './acl'

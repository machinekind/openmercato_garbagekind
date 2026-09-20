import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'fleet',
  title: 'Rejestr floty',
  version: '0.1.0',
  description: 'Roboty, klasy sprzętowe, obiekty, cele i kalibracje - z rozdziałem właściciela od operatora.',
  author: 'machinekind',
  license: 'MIT',
  // Świadomie pusto: rejestr floty nie zależy od żadnego modułu handlowego.
  // Jeśli kiedykolwiek pojawi się tu `catalog` albo `sales`, modelowanie
  // poszło złą drogą - patrz raport rozpoznawczy, sekcja o zgięciu platformy.
  requires: [],
  ejectable: true,
}

export { features } from './acl'

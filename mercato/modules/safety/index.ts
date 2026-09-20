import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'safety',
  title: 'Bezpieczeństwo i zgodność',
  version: '0.1.0',
  description:
    'Uzasadnienie bezpieczeństwa wiązane z klasą celi, zestawy ewaluacyjne wymagane przed dopuszczeniem i rejestr incydentów.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * `fleet` bo klasa celi i klasa ryzyka mieszkają tam; `policy_registry`
   * bo dopuszczenie dotyczy wersji polityki i jej odcisku kontraktu.
   *
   * Świadomie NIE ma tu `deployment` ani `rollout`. Kierunek jest odwrotny:
   * to kanał stanu pożądanego pyta warstwę bezpieczeństwa o zgodę przed
   * przypisaniem. Gdyby `safety` znał wdrożenia, zaczęłoby go kusić
   * zatrzymywanie ich samodzielnie - a wtedy dwie warstwy zatrzymywałyby
   * maszynę dwoma różnymi mechanizmami.
   */
  requires: ['fleet', 'policy_registry'],
  ejectable: true,
}

export { features } from './acl'

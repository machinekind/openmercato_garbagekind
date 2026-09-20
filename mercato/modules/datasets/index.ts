import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'datasets',
  title: 'Zbiory danych',
  version: '0.1.0',
  description:
    'Zbiory budowane z epizodów i interwencji, wersjonowane i powiązane z wersjami polityk, które z nich powstały.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * `episodes` bo zbiór powstaje z księgi; `policy_registry` bo pętla zamyka
   * się na wersji polityki; `fleet` bo rodzina embodimentu rozstrzyga, które
   * epizody w ogóle pasują do zbioru.
   *
   * Kierunek jest jednostronny i taki ma zostać. Gdyby `policy_registry`
   * zaczął wiedzieć o zbiorach, rejestracja wersji wymagałaby istnienia zbioru
   * - a wersja wgrana ręcznie, bez potoku treningowego, jest normalnym
   * przypadkiem w pierwszym miesiącu każdego wdrożenia.
   */
  requires: ['fleet', 'policy_registry', 'episodes'],
  ejectable: true,
}

export { features } from './acl'

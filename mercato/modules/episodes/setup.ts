import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * `employee` dostaje wszystko poza przeliczaniem liczników.
 *
 * Asymetria odwrotna niż przy wdrożeniach i z odwrotnego powodu: tutaj
 * chcemy, żeby zapisywali jak najwięcej. Przeliczenie liczników zostaje przy
 * administratorze, bo to operacja korygująca dane, po której raport zmienia
 * wartość - nie powinna się zdarzać przypadkiem.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['episodes.*'],
    employee: ['episodes.view', 'episodes.record', 'episodes.intervene'],
  },
}

export default setup

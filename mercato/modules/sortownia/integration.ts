import type { IntegrationBundle, IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

/**
 * System legacy sortowni jako zwykły konektor w hubie Data Sync.
 *
 * Adres i konto są polami integracji, więc przestawienie modułu na produkcyjną
 * instancję webERP to zmiana jednego pola w panelu - bez dotykania kodu.
 */

export const bundle: IntegrationBundle = {
  id: 'sortownia_legacy_bundle',
  title: 'Sortownia - system legacy',
  description: 'Most do starego systemu magazynowego sortowni odpadów (XML-RPC + zrzut plikowy).',
  package: 'src/modules/sortownia',
  version: '0.1.0',
  credentials: { fields: [] },
}

export const integration: IntegrationDefinition = {
  id: 'sortownia_legacy',
  title: 'Sortownia - system legacy (XML-RPC)',
  description:
    'Zasysa topologię magazynu po XML-RPC oraz katalog frakcji i księgę ruchów ze zrzutu plikowego. Ruchy trafiają do WMS jako przyjęcia, przesunięcia i korekty wydań.',
  category: 'data_sync',
  hub: 'data_sync',
  providerKey: 'sortownia_legacy',
  icon: 'database',
  package: 'src/modules/sortownia',
  version: '0.1.0',
  author: 'machinekind',
  license: 'MIT',
  bundleId: 'sortownia_legacy_bundle',
  tags: ['legacy', 'weberp', 'xml-rpc', 'odpady', 'wms'],
  credentials: {
    fields: [
      {
        key: 'endpoint',
        label: 'Endpoint XML-RPC',
        type: 'url',
        required: true,
        placeholder: 'http://127.0.0.1:8088/api/api_xml-rpc.php',
        helpText: 'Ścieżka jak w webERP: /api/api_xml-rpc.php. Ta sama wartość przestawia moduł na produkcję.',
      },
      {
        key: 'user',
        label: 'Użytkownik',
        type: 'text',
        required: true,
        placeholder: 'demo',
      },
      {
        key: 'password',
        label: 'Hasło',
        type: 'secret',
        required: true,
      },
      {
        key: 'company',
        label: 'Firma (company)',
        type: 'text',
        required: true,
        placeholder: 'weberpdemo',
        helpText: 'Trzeci argument logowania webERP. Zła wartość zwraca kod 4.',
      },
    ],
  },
}

export const integrations: IntegrationDefinition[] = [integration]

export default integration

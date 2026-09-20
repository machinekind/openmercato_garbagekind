import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  TenantScope,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { LegacyRpcClient, RPC_OK } from './legacyRpc'
import {
  customersFile,
  fileExists,
  fractionsFile,
  legacyOutDir,
  movementsFile,
  ordersFile,
  paymentsFile,
  readCustomers,
  readFractions,
  readMovements,
  readOrders,
  readPayments,
  type LegacyMovementRow,
} from './legacyFiles'
import { ensureCustomers, loadCustomerIndex } from './customers'
import { applySalesOrders, loadSalesOrderIndex } from './salesOrders'
import { applyPayments } from './payments'
import { ensureFractions, loadFractionIndex } from './fractions'
import { applyMovementBatch, type MovementContext } from './movements'
import { ensureTopology, loadLocationIndex } from './topology'

/**
 * Adapter data_sync dla systemu legacy sortowni.
 *
 * Kanał XML-RPC oddaje topologię magazynu (sześć metod, które istnieją także
 * w prawdziwym webERP). Kanał plikowy oddaje katalog frakcji i księgę ruchów,
 * bo tych webERP przez API nie wystawia. Kursorem jest numer ruchu legacy,
 * więc przerwany import wznawia się dokładnie tam, gdzie stanął.
 */

export const PROVIDER_KEY = 'sortownia_legacy'

export const ENTITY_TOPOLOGY = 'sortownia.topology'
export const ENTITY_FRACTIONS = 'sortownia.fractions'
export const ENTITY_MOVEMENTS = 'sortownia.movements'
export const ENTITY_CUSTOMERS = 'sortownia.customers'
export const ENTITY_SALES_ORDERS = 'sortownia.salesOrders'
export const ENTITY_PAYMENTS = 'sortownia.payments'

type Container = Awaited<ReturnType<typeof createRequestContainer>>

type LegacyCredentials = {
  endpoint: string
  user: string
  password: string
  company: string
}

/**
 * Preconfiguracja z env: świeża instalacja ma działać bez klikania po UI.
 * Wartości podane przy integracji mają pierwszeństwo.
 */
export function resolveCredentials(raw: Record<string, unknown> | undefined): LegacyCredentials {
  const pick = (key: string, envKey: string, fallback: string): string => {
    const value = raw?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    const fromEnv = process.env[envKey]
    return fromEnv && fromEnv.trim() ? fromEnv.trim() : fallback
  }
  return {
    endpoint: pick('endpoint', 'SORTOWNIA_RPC_URL', 'http://127.0.0.1:8088/api/api_xml-rpc.php'),
    user: pick('user', 'SORTOWNIA_RPC_USER', 'demo'),
    password: pick('password', 'SORTOWNIA_RPC_PASSWORD', 'demo'),
    company: pick('company', 'SORTOWNIA_RPC_COMPANY', 'weberpdemo'),
  }
}

async function connect(raw: Record<string, unknown> | undefined): Promise<LegacyRpcClient> {
  const credentials = resolveCredentials(raw)
  const client = new LegacyRpcClient(credentials.endpoint)
  const code = await client.login(credentials.user, credentials.password, credentials.company)
  if (code !== RPC_OK) {
    throw new Error(`System legacy odrzucił logowanie (kod ${code}).`)
  }
  return client
}

function buildCommandContext(container: Container, scope: TenantScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as CommandRuntimeContext
}

/** Operator, któremu przypiszemy ruchy: konto techniczne importu. */
async function resolveOperator(em: EntityManager, scope: TenantScope): Promise<string> {
  const preferred = process.env.SORTOWNIA_OPERATOR_EMAIL
  if (preferred) {
    const byEmail = await em.findOne(User, { email: preferred, tenantId: scope.tenantId })
    if (byEmail) return byEmail.id
  }
  const anyUser = await em.findOne(User, { tenantId: scope.tenantId }, { orderBy: { createdAt: 'asc' } })
  if (!anyUser) throw new Error('Brak użytkownika w tenancie - nie ma komu przypisać ruchów magazynowych.')
  return anyUser.id
}

type MovementCursor = { lastMoveNo: number }

export function parseMovementCursor(value: string | null | undefined): MovementCursor {
  if (!value) return { lastMoveNo: 0 }
  try {
    const parsed = JSON.parse(value) as Partial<MovementCursor> | number
    // Goły numer jest poprawnym JSON-em, więc nie wpadłby do `catch`:
    // starszy przebieg zapisywał kursor właśnie tak, a odczytany jako 0
    // kazałby importowi przejść całą księgę od nowa.
    if (typeof parsed === 'number') {
      return { lastMoveNo: Number.isFinite(parsed) ? parsed : 0 }
    }
    const last = Number(parsed?.lastMoveNo)
    return { lastMoveNo: Number.isFinite(last) ? last : 0 }
  } catch {
    const numeric = Number(value)
    return { lastMoveNo: Number.isFinite(numeric) ? numeric : 0 }
  }
}

const MAPPINGS: Record<string, DataMapping> = {
  [ENTITY_TOPOLOGY]: {
    entityType: ENTITY_TOPOLOGY,
    matchStrategy: 'externalId',
    fields: [
      { externalField: 'loccode', localField: 'code', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'locationname', localField: 'metadata.legacyName', mappingKind: 'metadata' },
      { externalField: 'deladd1', localField: 'metadata.legacyAddress', mappingKind: 'metadata' },
    ],
  },
  [ENTITY_FRACTIONS]: {
    entityType: ENTITY_FRACTIONS,
    matchStrategy: 'sku',
    matchField: 'sku',
    fields: [
      { externalField: 'stockid', localField: 'sku', mappingKind: 'core', required: true, dedupeRole: 'primary' },
      { externalField: 'nazwa', localField: 'title', mappingKind: 'core' },
      { externalField: 'kategoria', localField: 'metadata.kategoria', mappingKind: 'metadata' },
    ],
  },
  [ENTITY_CUSTOMERS]: {
    entityType: ENTITY_CUSTOMERS,
    matchStrategy: 'externalId',
    fields: [
      { externalField: 'debtorno', localField: 'source', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'name', localField: 'displayName', mappingKind: 'core', required: true },
      { externalField: 'nip', localField: 'description', mappingKind: 'core' },
      { externalField: 'typ', localField: 'metadata.rola', mappingKind: 'metadata' },
    ],
  },
  [ENTITY_SALES_ORDERS]: {
    entityType: ENTITY_SALES_ORDERS,
    matchStrategy: 'externalId',
    fields: [
      { externalField: 'orderno', localField: 'externalReference', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'debtorno', localField: 'customerEntityId', mappingKind: 'relation', required: true },
      { externalField: 'stockid', localField: 'lines.productVariantId', mappingKind: 'relation', required: true },
      { externalField: 'ilosc_kg', localField: 'lines.quantity', mappingKind: 'core', required: true },
      { externalField: 'cena_kg', localField: 'lines.unitPriceNet', mappingKind: 'core', required: true },
    ],
  },
  [ENTITY_PAYMENTS]: {
    entityType: ENTITY_PAYMENTS,
    matchStrategy: 'externalId',
    fields: [
      { externalField: 'transno', localField: 'paymentReference', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'orderno', localField: 'orderId', mappingKind: 'relation', required: true },
      { externalField: 'kwota_brutto', localField: 'amount', mappingKind: 'core', required: true },
      { externalField: 'data', localField: 'receivedAt', mappingKind: 'core' },
    ],
  },
  [ENTITY_MOVEMENTS]: {
    entityType: ENTITY_MOVEMENTS,
    matchStrategy: 'externalId',
    fields: [
      { externalField: 'stkmoveno', localField: 'referenceId', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
      { externalField: 'typ', localField: 'type', mappingKind: 'core', required: true },
      { externalField: 'ilosc_kg', localField: 'quantity', mappingKind: 'core', required: true },
      { externalField: 'loccode', localField: 'locationId', mappingKind: 'relation', required: true },
    ],
  },
}

export const sortowniaLegacyAdapter: DataSyncAdapter = {
  providerKey: PROVIDER_KEY,
  direction: 'import',
  supportedEntities: [
    ENTITY_TOPOLOGY,
    ENTITY_FRACTIONS,
    // Kolejność nie jest kosmetyczna: zamówienie potrzebuje kontrahenta
    // i frakcji, a ruch WZ potrzebuje zamówienia, żeby je wskazać.
    ENTITY_CUSTOMERS,
    ENTITY_SALES_ORDERS,
    ENTITY_PAYMENTS,
    ENTITY_MOVEMENTS,
  ],
  runMode: 'generic',
  runParameters: [
    {
      key: 'dryRun',
      label: 'Przebieg próbny',
      labelKey: 'sortownia.sync.params.dryRun',
      type: 'boolean',
      defaultValue: false,
      description: 'Policz, co weszłoby do magazynu, bez zapisu ruchów.',
    },
  ],

  async getMapping(input): Promise<DataMapping> {
    return MAPPINGS[input.entityType] ?? MAPPINGS[ENTITY_MOVEMENTS]
  },

  supportsStartControl(control) {
    return control === 'fullSync' || control === 'batchSize'
  },

  async getInitialCursor(): Promise<string | null> {
    return null
  },

  async validateConnection(input): Promise<ValidationResult> {
    try {
      const client = await connect(input.credentials)
      const locations = await client.getLocationList()
      const notes: string[] = [`XML-RPC odpowiada, lokalizacji: ${locations.length}.`]

      if (input.entityType === ENTITY_MOVEMENTS || input.entityType === ENTITY_FRACTIONS) {
        const file = input.entityType === ENTITY_MOVEMENTS ? movementsFile() : fractionsFile()
        if (!(await fileExists(file))) {
          return {
            ok: false,
            message: `Brak zrzutu plikowego: ${file}. Uruchom eksport po stronie systemu legacy.`,
          }
        }
        notes.push(`Zrzut plikowy: ${file}.`)
      }

      return { ok: true, message: notes.join(' ') }
    } catch (error) {
      return {
        ok: false,
        message: `Nie udało się połączyć z systemem legacy: ${(error as Error)?.message ?? error}`,
      }
    }
  },

  async *streamImport(input): AsyncIterable<ImportBatch> {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = input.scope
    const dryRun = input.parameters?.dryRun === true

    if (input.entityType === ENTITY_TOPOLOGY) {
      const client = await connect(input.credentials)
      const list = await client.getLocationList()
      const detailed = []
      for (const location of list) {
        const details = await client.getLocationDetails(location.loccode)
        detailed.push({ ...location, ...(details ?? {}) })
      }

      const items: ImportItem[] = detailed.map((location) => ({
        externalId: location.loccode,
        data: location as unknown as Record<string, unknown>,
        action: 'update',
      }))

      if (!dryRun) await ensureTopology(em, scope, detailed)

      yield {
        items,
        cursor: JSON.stringify({ topologySyncedAt: new Date().toISOString() }),
        hasMore: false,
        totalEstimate: detailed.length,
        processedCount: detailed.length,
        batchIndex: 0,
        message: dryRun
          ? `Przebieg próbny: ${detailed.length} lokalizacji z XML-RPC.`
          : `Zsynchronizowano topologię magazynu: ${detailed.length} lokalizacji.`,
      }
      return
    }

    if (input.entityType === ENTITY_FRACTIONS) {
      const file = fractionsFile()
      if (!(await fileExists(file))) {
        throw new Error(`Brak pliku z katalogiem frakcji: ${file}`)
      }
      const fractions = await readFractions(file)
      const items: ImportItem[] = fractions.map((fraction) => ({
        externalId: fraction.stockid,
        data: fraction as unknown as Record<string, unknown>,
        action: 'update',
      }))

      if (!dryRun) await ensureFractions(em, scope, fractions)

      yield {
        items,
        cursor: JSON.stringify({ fractionsSyncedAt: new Date().toISOString() }),
        hasMore: false,
        totalEstimate: fractions.length,
        processedCount: fractions.length,
        batchIndex: 0,
        message: dryRun
          ? `Przebieg próbny: ${fractions.length} frakcji w zrzucie.`
          : `Zsynchronizowano katalog frakcji: ${fractions.length} pozycji.`,
      }
      return
    }

    if (input.entityType === ENTITY_CUSTOMERS) {
      const file = customersFile()
      if (!(await fileExists(file))) {
        throw new Error(`Brak listy kontrahentów w zrzucie: ${file}`)
      }
      const rows = await readCustomers(file)
      const items: ImportItem[] = rows.map((row) => ({
        externalId: row.debtorno,
        data: row as unknown as Record<string, unknown>,
        action: 'update',
      }))

      let created = 0
      if (!dryRun) {
        const result = await ensureCustomers(
          {
            em,
            commandBus: container.resolve('commandBus') as CommandBus,
            commandContext: buildCommandContext(container, scope),
            scope,
          },
          rows,
        )
        created = result.outcomes.filter((outcome) => outcome.action === 'create').length
      }

      yield {
        items,
        cursor: JSON.stringify({ customersSyncedAt: new Date().toISOString() }),
        hasMore: false,
        totalEstimate: rows.length,
        processedCount: rows.length,
        batchIndex: 0,
        message: dryRun
          ? `Przebieg próbny: ${rows.length} kontrahentów w zrzucie.`
          : `Zsynchronizowano kontrahentów: ${rows.length} pozycji (nowych ${created}).`,
      }
      return
    }

    if (input.entityType === ENTITY_SALES_ORDERS) {
      const file = ordersFile()
      if (!(await fileExists(file))) {
        throw new Error(`Brak zamówień w zrzucie: ${file}`)
      }
      const rows = await readOrders(file)
      const items: ImportItem[] = rows.map((row) => ({
        externalId: String(row.orderno),
        data: row as unknown as Record<string, unknown>,
        action: 'update',
      }))

      let created = 0
      let invoiced = 0
      if (!dryRun) {
        const result = await applySalesOrders(
          {
            em,
            commandBus: container.resolve('commandBus') as CommandBus,
            commandContext: buildCommandContext(container, scope),
            scope,
            customers: await loadCustomerIndex(em, scope),
            fractions: await loadFractionIndex(em, scope),
            issueInvoices: true,
          },
          rows,
        )
        created = result.outcomes.filter((outcome) => outcome.action === 'create').length
        invoiced = result.outcomes.filter((outcome) => outcome.invoiced).length
      }

      yield {
        items,
        cursor: JSON.stringify({ salesOrdersSyncedAt: new Date().toISOString() }),
        hasMore: false,
        totalEstimate: rows.length,
        processedCount: rows.length,
        batchIndex: 0,
        message: dryRun
          ? `Przebieg próbny: ${rows.length} zamówień w zrzucie.`
          : `Zsynchronizowano zamówienia: ${rows.length} pozycji (nowych ${created}, faktur ${invoiced}).`,
      }
      return
    }

    if (input.entityType === ENTITY_PAYMENTS) {
      const file = paymentsFile()
      if (!(await fileExists(file))) {
        throw new Error(`Brak wpłat w zrzucie: ${file}`)
      }
      const rows = await readPayments(file)
      const items: ImportItem[] = rows.map((row) => ({
        externalId: String(row.transno),
        data: row as unknown as Record<string, unknown>,
        action: 'update',
      }))

      let created = 0
      if (!dryRun) {
        const result = await applyPayments(
          {
            em,
            commandBus: container.resolve('commandBus') as CommandBus,
            commandContext: buildCommandContext(container, scope),
            scope,
            orders: await loadSalesOrderIndex(em, scope),
          },
          rows,
        )
        created = result.outcomes.filter((outcome) => outcome.action === 'create').length
      }

      yield {
        items,
        cursor: JSON.stringify({ paymentsSyncedAt: new Date().toISOString() }),
        hasMore: false,
        totalEstimate: rows.length,
        processedCount: rows.length,
        batchIndex: 0,
        message: dryRun
          ? `Przebieg próbny: ${rows.length} wpłat w zrzucie.`
          : `Zsynchronizowano wpłaty: ${rows.length} pozycji (nowych ${created}).`,
      }
      return
    }

    if (input.entityType !== ENTITY_MOVEMENTS) {
      throw new Error(`Nieobsługiwany typ encji: ${input.entityType}`)
    }

    const file = movementsFile()
    if (!(await fileExists(file))) {
      throw new Error(`Brak księgi ruchów w zrzucie: ${file} (katalog: ${legacyOutDir()})`)
    }

    const { warehouse, byCode } = await loadLocationIndex(em, scope)
    if (!warehouse) {
      throw new Error('Magazyn sortowni nie istnieje - uruchom najpierw import topologii.')
    }
    const fractions = await loadFractionIndex(em, scope)
    const commandBus = container.resolve('commandBus') as CommandBus
    const movementContext: MovementContext = {
      em,
      commandBus,
      commandContext: buildCommandContext(container, scope),
      salesOrders: await loadSalesOrderIndex(em, scope),
      scope,
      warehouseId: warehouse.id,
      locations: byCode,
      fractions,
      performedBy: await resolveOperator(em, scope),
    }

    const cursor = parseMovementCursor(input.cursor)
    let batchIndex = 0
    let processed = 0
    let buffer: LegacyMovementRow[] = []
    let carry: LegacyMovementRow[] = []

    const flush = async (hasMore: boolean): Promise<ImportBatch | null> => {
      if (buffer.length === 0) return null
      const rows = buffer
      buffer = []

      let outcomes
      if (dryRun) {
        outcomes = rows.map((row) => ({
          externalId: String(row.stkmoveno),
          action: 'skip' as const,
          stkmoveno: row.stkmoveno,
        }))
      } else {
        const result = await applyMovementBatch(movementContext, rows, { carry, final: !hasMore })
        outcomes = result.outcomes
        carry = result.carry
      }

      const lastMoveNo = rows.reduce((max, row) => Math.max(max, row.stkmoveno), cursor.lastMoveNo)
      cursor.lastMoveNo = lastMoveNo
      processed += rows.length

      const items: ImportItem[] = outcomes.map((outcome) => {
        const error = 'error' in outcome ? outcome.error ?? null : null
        return {
          externalId: outcome.externalId,
          data: { stkmoveno: outcome.stkmoveno, error },
          action: outcome.action,
        }
      })

      const duplicates = outcomes.filter((outcome) => outcome.action === 'skip').length
      const failures = outcomes.filter((outcome) => outcome.action === 'failed').length

      return {
        items,
        cursor: JSON.stringify({ lastMoveNo }),
        hasMore,
        processedCount: processed,
        batchIndex: batchIndex++,
        message: dryRun
          ? `Przebieg próbny: ${rows.length} ruchów do numeru ${lastMoveNo}.`
          : `Ruchy do numeru ${lastMoveNo}: zapisane ${outcomes.length - duplicates - failures}, duplikaty ${duplicates}, błędy ${failures}.`,
      }
    }

    const batchSize = Math.max(1, input.batchSize || 50)
    for await (const row of readMovements(file)) {
      if (row.stkmoveno <= cursor.lastMoveNo) continue
      buffer.push(row)
      if (buffer.length < batchSize) continue
      if (input.signal?.aborted) return
      const batch = await flush(true)
      if (batch) yield batch
    }

    const tail = await flush(false)
    if (tail) {
      yield tail
      return
    }

    yield {
      items: [],
      cursor: JSON.stringify({ lastMoveNo: cursor.lastMoveNo }),
      hasMore: false,
      processedCount: processed,
      batchIndex,
      message: 'Brak nowych ruchów w księdze legacy.',
    }
  },
}

export default sortowniaLegacyAdapter

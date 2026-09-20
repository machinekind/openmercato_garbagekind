import type { EntityManager } from '@mikro-orm/postgresql'
import { CatalogProduct, CatalogProductVariant } from '@open-mercato/core/modules/catalog/data/entities'
import { ProductInventoryProfile } from '@open-mercato/core/modules/wms/data/entities'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { LegacyFractionRow } from './legacyFiles'

/**
 * Frakcje odpadów jako pozycje katalogu.
 *
 * W legacy frakcja to wiersz w `stockmaster` i nic więcej. Tutaj staje się
 * produktem z wariantem, którego SKU jest kodem odpadu - dzięki temu WMS może
 * prowadzić dla niej stany, a moduły sprzedaży wystawić wydanie do odbiorcy.
 * Profil zapasu dokłada próg minimalny, czyli wiedzę, której stary system
 * nie miał gdzie zapisać.
 */

export type FractionIndex = Map<string, { productId: string; variantId: string }>

/** Progi operacyjne per frakcja: poniżej nie opłaca się wysyłać transportu. */
const REORDER_POINT_KG: Record<string, number> = {
  '20 01 01': 8_000,
  '15 01 02': 6_000,
  '20 01 02': 10_000,
  '20 01 40': 5_000,
  '19 12 10': 15_000,
  '20 02 01': 12_000,
}

function handleFor(stockid: string): string {
  return `frakcja-${stockid.replace(/\s+/g, '-').toLowerCase()}`
}

export async function ensureFractions(
  em: EntityManager,
  scope: TenantScope,
  fractions: LegacyFractionRow[],
): Promise<{ index: FractionIndex; created: number; updated: number }> {
  const index: FractionIndex = new Map()
  let created = 0
  let updated = 0

  for (const fraction of fractions) {
    const sku = fraction.stockid.trim()
    if (!sku) continue

    let variant = await em.findOne(CatalogProductVariant, {
      sku,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })

    let product = variant ? await em.findOne(CatalogProduct, { id: (variant.product as unknown as { id: string }).id }) : null

    if (!product) {
      product = em.create(CatalogProduct, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        title: fraction.nazwa,
        sku,
        handle: handleFor(sku),
        description: `Frakcja odpadów, kod ${sku}. Źródło: system legacy sortowni.`,
        defaultUnit: 'kg',
        productType: 'simple',
        isActive: true,
      } as unknown as CatalogProduct)
      em.persist(product)
      await em.flush()
      created += 1
    } else {
      product.title = fraction.nazwa
      updated += 1
    }

    if (!variant) {
      variant = em.create(CatalogProductVariant, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        product,
        name: fraction.nazwa,
        sku,
        isDefault: true,
        isActive: true,
      } as unknown as CatalogProductVariant)
      em.persist(variant)
      await em.flush()
      created += 1
    } else {
      variant.name = fraction.nazwa
    }

    let profile = await em.findOne(ProductInventoryProfile, {
      catalogVariantId: variant.id,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    const reorderPoint = REORDER_POINT_KG[sku]
    if (!profile) {
      profile = em.create(ProductInventoryProfile, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        catalogProductId: (product as unknown as { id: string }).id,
        catalogVariantId: variant.id,
        // Magazyn prowadzimy w kilogramach - tak liczy waga i tak liczy legacy.
        // Megagramy są jednostką raportową, nie magazynową.
        defaultUom: 'kg',
        // Odpad nie ma partii ani dat ważności, więc najprostsza strategia wystarcza.
        defaultStrategy: 'fifo',
        trackLot: false,
        trackSerial: false,
        trackExpiration: false,
        reorderPoint: reorderPoint === undefined ? null : String(reorderPoint),
        metadata: {
          legacyStockid: sku,
          kategoria: fraction.kategoria,
          jednostkaLegacy: fraction.jednostka,
          // Kod procesu odzysku trafia na kartę przekazania odpadu, więc musi
          // być przy frakcji, a nie wpisywany ręcznie przy każdym wydaniu.
          kodProcesu: fraction.kodProcesu || null,
        },
      } as unknown as ProductInventoryProfile)
      em.persist(profile)
      created += 1
    } else if (reorderPoint !== undefined) {
      profile.reorderPoint = String(reorderPoint)
    }

    index.set(sku, { productId: (product as unknown as { id: string }).id, variantId: variant.id })
  }

  await em.flush()
  return { index, created, updated }
}

export async function loadFractionIndex(em: EntityManager, scope: TenantScope): Promise<FractionIndex> {
  const variants = await em.find(CatalogProductVariant, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  const index: FractionIndex = new Map()
  for (const variant of variants) {
    if (!variant.sku) continue
    const productId = (variant.product as unknown as { id: string })?.id
    index.set(variant.sku, { productId, variantId: variant.id })
  }
  return index
}

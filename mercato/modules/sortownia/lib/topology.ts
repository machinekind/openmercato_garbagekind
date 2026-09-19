import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Warehouse,
  WarehouseLocation,
  WarehouseZone,
  type WarehouseLocationType,
} from '@open-mercato/core/modules/wms/data/entities'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { LegacyLocation } from './legacyRpc'

/**
 * Topologia sortowni w pojęciach WMS.
 *
 * System legacy zna jedną płaską listę kodów (`PRZYJ`, `BOKS1`, `MAGRDF`).
 * WMS rozróżnia magazyn, strefę i lokalizację, a lokalizacja ma typ i pojemność
 * — dlatego boks wreszcie wie, ile się w nim mieści, czego stary system nie
 * potrafił wyrazić w żadnym polu.
 */

export const WAREHOUSE_CODE = 'SORT-WLS'
export const WAREHOUSE_NAME = 'Sortownia Wieliszew'

type ZoneSpec = { code: string; name: string; priority: number }

const ZONES: ZoneSpec[] = [
  { code: 'PRZYJECIA', name: 'Przyjęcia i plac', priority: 10 },
  { code: 'BOKSY', name: 'Boksy sortownicze', priority: 20 },
  { code: 'PALIWO', name: 'Magazyn paliwa alternatywnego', priority: 30 },
]

/** Jak kod z legacy ma się odwzorować na topologię WMS. */
export type LocationPlan = {
  zoneCode: string
  type: WarehouseLocationType
  /** Pojemność w kilogramach — wiedza operacyjna, której legacy nie trzymał. */
  capacityKg: number | null
}

const LOCATION_PLAN: Record<string, LocationPlan> = {
  PRZYJ: { zoneCode: 'PRZYJECIA', type: 'staging', capacityKg: 150_000 },
  BOKS1: { zoneCode: 'BOKSY', type: 'bin', capacityKg: 60_000 },
  BOKS2: { zoneCode: 'BOKSY', type: 'bin', capacityKg: 60_000 },
  BOKS3: { zoneCode: 'BOKSY', type: 'bin', capacityKg: 80_000 },
  BOKS4: { zoneCode: 'BOKSY', type: 'bin', capacityKg: 80_000 },
  MAGRDF: { zoneCode: 'PALIWO', type: 'bin', capacityKg: 120_000 },
}

export function planFor(loccode: string): LocationPlan {
  return LOCATION_PLAN[loccode.toUpperCase()] ?? { zoneCode: 'BOKSY', type: 'bin', capacityKg: null }
}

export type TopologyResult = {
  warehouse: Warehouse
  zones: Map<string, WarehouseZone>
  locations: Map<string, WarehouseLocation>
  created: number
  updated: number
}

/**
 * Upsert magazynu, stref i lokalizacji na podstawie tego, co odda XML-RPC.
 *
 * Ponowne uruchomienie nie duplikuje niczego: kluczem jest kod, a nie kolejność
 * rekordów w starym systemie.
 */
export async function ensureTopology(
  em: EntityManager,
  scope: TenantScope,
  legacyLocations: LegacyLocation[],
): Promise<TopologyResult> {
  let created = 0
  let updated = 0

  let warehouse = await em.findOne(Warehouse, {
    code: WAREHOUSE_CODE,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  if (!warehouse) {
    warehouse = em.create(Warehouse, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      code: WAREHOUSE_CODE,
      name: WAREHOUSE_NAME,
      isActive: true,
    } as Warehouse)
    em.persist(warehouse)
    created += 1
  }
  await em.flush()

  const zones = new Map<string, WarehouseZone>()
  for (const spec of ZONES) {
    let zone = await em.findOne(WarehouseZone, {
      warehouse: warehouse.id,
      code: spec.code,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    if (!zone) {
      zone = em.create(WarehouseZone, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouse,
        code: spec.code,
        name: spec.name,
        priority: spec.priority,
      } as WarehouseZone)
      em.persist(zone)
      created += 1
    }
    zones.set(spec.code, zone)
  }
  await em.flush()

  const locations = new Map<string, WarehouseLocation>()
  for (const legacy of legacyLocations) {
    const code = (legacy.loccode ?? '').trim().toUpperCase()
    if (!code) continue
    const plan = planFor(code)

    let location = await em.findOne(WarehouseLocation, {
      warehouse: warehouse.id,
      code,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })

    const metadata = {
      legacyLoccode: code,
      legacyName: legacy.locationname ?? null,
      legacyAddress: legacy.deladd1 ?? null,
      zone: plan.zoneCode,
    }

    if (!location) {
      location = em.create(WarehouseLocation, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouse,
        code,
        type: plan.type,
        isActive: true,
        capacityWeight: plan.capacityKg === null ? null : String(plan.capacityKg),
        metadata,
      } as never)
      em.persist(location)
      created += 1
    } else {
      location.type = plan.type
      location.capacityWeight = plan.capacityKg === null ? null : String(plan.capacityKg)
      location.metadata = metadata
      updated += 1
    }
    locations.set(code, location)
  }
  await em.flush()

  return { warehouse, zones, locations, created, updated }
}

export async function loadLocationIndex(
  em: EntityManager,
  scope: TenantScope,
): Promise<{ warehouse: Warehouse | null; byCode: Map<string, WarehouseLocation> }> {
  const warehouse = await em.findOne(Warehouse, {
    code: WAREHOUSE_CODE,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  if (!warehouse) return { warehouse: null, byCode: new Map() }

  const locations = await em.find(WarehouseLocation, {
    warehouse: warehouse.id,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  })
  const byCode = new Map<string, WarehouseLocation>()
  for (const location of locations) byCode.set(location.code.toUpperCase(), location)
  return { warehouse, byCode }
}

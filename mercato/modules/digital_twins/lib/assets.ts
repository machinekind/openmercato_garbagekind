import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type PackagedAssetName =
  | 'room.glb'
  | 'room.manifest.json'
  | 'cameras.manifest.json'
  | 'viewer.js'
  | 'tracker.js'
  | 'poster.webp'
  | 'detector.model.json'
  | 'group1-shard1of5'
  | 'group1-shard2of5'
  | 'group1-shard3of5'
  | 'group1-shard4of5'
  | 'group1-shard5of5'

export async function readPackagedAsset(name: PackagedAssetName): Promise<Buffer> {
  const configured = process.env.DIGITAL_TWINS_ASSET_DIR
  const roots = configured ? [configured] : [
    path.join(process.cwd(), 'src/modules/digital_twins/assets'),
    path.join(process.cwd(), 'apps/mercato/src/modules/digital_twins/assets'),
  ]
  for (const root of roots) {
    try {
      return await readFile(path.join(root, name))
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('[internal] Packaged digital twin asset is unavailable')
}

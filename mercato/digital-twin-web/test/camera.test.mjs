import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const assets = new URL('../../modules/digital_twins/assets/', import.meta.url)
const cameras = JSON.parse(await readFile(new URL('cameras.manifest.json', assets), 'utf8'))
const room = JSON.parse(await readFile(new URL('room.manifest.json', assets), 'utf8'))
const detector = JSON.parse(await readFile(new URL('detector.model.json', assets), 'utf8'))

test('camera commissioning profile stays within the twin and disables identity recognition', () => {
  assert.equal(cameras.roomId, room.id)
  assert.ok(cameras.cameras.length > 0)
  for (const camera of cameras.cameras) {
    assert.equal(camera.calibration.state, 'estimated')
    assert.equal(camera.privacy.identityRecognition, false)
    assert.equal(camera.privacy.rawVideoUploaded, false)
    assert.equal(camera.privacy.trackRetention, 'session')
    for (const [x, z] of camera.calibration.twinFloorPolygon) {
      assert.ok(x >= room.bounds.min[0] && x <= room.bounds.max[0])
      assert.ok(z >= room.bounds.min[2] && z <= room.bounds.max[2])
    }
  }
})

test('packaged detector manifest resolves every local weight shard', async () => {
  const paths = [...new Set(detector.weightsManifest.flatMap((group) => group.paths))]
  assert.deepEqual(paths, ['group1-shard1of5', 'group1-shard2of5', 'group1-shard3of5', 'group1-shard4of5', 'group1-shard5of5'])
  for (const path of paths) assert.ok((await stat(new URL(path, assets))).size > 0)
})

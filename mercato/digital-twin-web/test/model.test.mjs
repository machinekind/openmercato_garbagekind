import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { Box3 } from 'three'

const root = new URL('../../modules/digital_twins/assets/', import.meta.url)
const bytes = await readFile(new URL('room.glb', root))
const manifest = JSON.parse(await readFile(new URL('room.manifest.json', root), 'utf8'))
const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
const loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')

test('web payload is self-contained and omits photographic evidence and animation', () => {
  assert.equal(gltf.asset.version, '2.0')
  assert.equal(gltf.images, undefined)
  assert.equal(gltf.animations, undefined)
  assert.equal(gltf.buffers.length, 1)
  assert.equal(gltf.buffers[0].uri, undefined)
  assert.ok(bytes.length < 4_000_000)
  assert.ok(manifest.stats.modelBytes < manifest.stats.sourceBytes * .1)
  assert.equal(manifest.stats.modelBytes, bytes.length)
})

test('every selectable element resolves to glTF geometry with matching world bounds', () => {
  loaded.scene.updateMatrixWorld(true)
  for (const element of manifest.elements) {
    const node = loaded.scene.getObjectByName(element.nodeName)
    assert.ok(node, element.id)
    assert.equal(node.userData.elementId, element.id)
    assert.equal(node.userData.layerId, element.layerId)
    const bounds = new Box3().setFromObject(node)
    for (const side of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(bounds[side].getComponent(axis) - element.bounds[side][axis]) < .001, element.id + ' ' + side)
    }
  }
})

test('export retains all modeled objects, curtains and measured tables', () => {
  assert.equal(manifest.elements.reduce((sum, entry) => sum + entry.sourceObjectCount, 0), manifest.stats.sourceObjects)
  assert.equal(manifest.layers.find((entry) => entry.id === 'curtains').objectCount, 11)
  assert.equal(manifest.elements.filter((entry) => entry.confidence === 'measured').length, 7)
  assert.equal(manifest.layers.find((entry) => entry.id === 'roof').defaultVisible, false)
  assert.equal(manifest.provenance.geometricOnly, true)
  assert.equal(manifest.provenance.scaleVerified, false)
})

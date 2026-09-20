import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalSpecForm,
  collectUnknowns,
  computeSpecDigest,
  validateEmbodimentSpec,
  type EmbodimentSpec,
} from '../lib/embodimentSpec'

/**
 * Opis embodimentu skonfrontowany z prawdziwym ramieniem.
 *
 * SO-101 jest tu wzorcem, bo jest dobrze udokumentowany. Wartość tych testów
 * polega jednak na czymś innym: sprawdzają zachowanie formatu wobec ramion
 * **gorzej** udokumentowanych - takich, gdzie połowy liczb nikt nie zna.
 */

const so101 = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'so101_follower.json'), 'utf8'),
) as EmbodimentSpec

describe('SO-101 jako wzorzec', () => {
  it('opis z dokumentacji przechodzi walidację', () => {
    expect(validateEmbodimentSpec(so101).valid).toBe(true)
  })

  it('ma sześć stawów i sześć stopni swobody', () => {
    expect(so101.actuators.joints).toHaveLength(6)
    expect(so101.kinematics.dofCount).toBe(6)
  })

  it('NIE jest kompletny - dokumentacja nie podaje udźwigu ani zasięgu', () => {
    // To jest właściwy wynik, nie usterka. Dokumentacja LeRobot opisuje montaż
    // i kalibrację, ale nie podaje udźwigu ani zasięgu. Opis ma to przyznać,
    // zamiast wpisać liczbę, której nikt nie zmierzył.
    const verdict = validateEmbodimentSpec(so101)
    expect(verdict.complete).toBe(false)
    expect(verdict.unknownFields).toEqual(
      expect.arrayContaining(['kinematics.payloadKg', 'kinematics.reachMm']),
    )
  })

  it('wymaga kalibracji przesunięć stawowych', () => {
    expect(so101.requiredCalibrations).toContain('joint_offsets')
  })
})

describe('odcisk kontraktu', () => {
  it('jest powtarzalny i niezależny od kolejności kluczy', () => {
    const przestawiony = JSON.parse(JSON.stringify(so101)) as EmbodimentSpec
    const joints = przestawiony.actuators.joints
    przestawiony.actuators = { ...przestawiony.actuators, joints }
    expect(computeSpecDigest(przestawiony)).toBe(computeSpecDigest(so101))
  })

  it('METRYCZKA NIE WCHODZI: dopisanie źródła nie unieważnia polityk', () => {
    const zeZrodlem = {
      ...so101,
      provenance: { ...so101.provenance, sources: ['https://przyklad/nowy'] },
      name: 'SO-101 Follower (poprawiona literówka)',
    }
    expect(computeSpecDigest(zeZrodlem)).toBe(computeSpecDigest(so101))
  })

  it('KONTRAKT WCHODZI: zmiana przełożenia w jednym stawie zmienia odcisk', () => {
    const inne = JSON.parse(JSON.stringify(so101)) as EmbodimentSpec
    inne.actuators.joints[0].gearRatio = '1/191'
    expect(computeSpecDigest(inne)).not.toBe(computeSpecDigest(so101))
  })

  it('zmiana liczby stawów zmienia odcisk', () => {
    const krotsze = JSON.parse(JSON.stringify(so101)) as EmbodimentSpec
    krotsze.actuators.joints.pop()
    krotsze.kinematics.dofCount = 5
    expect(computeSpecDigest(krotsze)).not.toBe(computeSpecDigest(so101))
  })

  it('postać kanoniczna nie zawiera prowenancji', () => {
    expect(canonicalSpecForm(so101)).not.toContain('huggingface.co')
  })
})

describe('ramiona gorzej udokumentowane', () => {
  const kiepskoOpisane: EmbodimentSpec = {
    embodimentKey: 'nieznane_ramie',
    revision: 1,
    name: 'Ramię bez dokumentacji',
    kinematics: { type: 'serial_manipulator', dofCount: 4, payloadKg: 'unknown', reachMm: 'unknown' },
    actuators: {
      joints: [{ name: 'j1' }, { name: 'j2' }, { name: 'j3' }, { name: 'j4' }],
      bus: 'unknown',
      protocol: 'unknown',
    },
    requiredCalibrations: ['joint_offsets'],
  }

  it('wolno je zaewidencjonować mimo luk', () => {
    // Inwentaryzacja ramienia, którego nikt do końca nie zna, jest tym,
    // od czego zaczyna się każde wdrożenie. Odmowa zapisu wypchnęłaby
    // te maszyny poza system - czyli tam, gdzie już są.
    expect(validateEmbodimentSpec(kiepskoOpisane).valid).toBe(true)
  })

  it('ale nie wolno na ich podstawie dopuścić polityki', () => {
    const verdict = validateEmbodimentSpec(kiepskoOpisane)
    expect(verdict.complete).toBe(false)
    expect(verdict.unknownFields).toHaveLength(4)
  })

  it('luki są wyliczone co do ścieżki, nie zliczone', () => {
    // Operator ma dostać listę tego, co trzeba zmierzyć, a nie komunikat
    // „opis niekompletny".
    expect(collectUnknowns(kiepskoOpisane).sort()).toEqual([
      'actuators.bus',
      'actuators.protocol',
      'kinematics.payloadKg',
      'kinematics.reachMm',
    ])
  })
})

describe('kontrole zdrowego rozsądku', () => {
  it('łapie opis skopiowany z innego ramienia i poprawiony w połowie', () => {
    const polowicznie = JSON.parse(JSON.stringify(so101)) as EmbodimentSpec
    polowicznie.actuators.joints.pop()
    const verdict = validateEmbodimentSpec(polowicznie)
    expect(verdict.valid).toBe(false)
    expect(verdict.problems.some((p) => p.path === 'kinematics.dofCount')).toBe(true)
  })

  it('łapie powtórzoną nazwę stawu', () => {
    const duplikat = JSON.parse(JSON.stringify(so101)) as EmbodimentSpec
    duplikat.actuators.joints[1].name = 'shoulder_pan'
    expect(validateEmbodimentSpec(duplikat).valid).toBe(false)
  })

  it('odrzuca opis bez stawów', () => {
    expect(validateEmbodimentSpec({ embodimentKey: 'x', revision: 1, name: 'x' }).valid).toBe(false)
  })
})

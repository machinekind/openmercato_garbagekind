import { evaluateCalibration, expiringWithin, type CalibrationRecord } from '../lib/calibration'

/**
 * Kalibracja jest warunkiem dopuszczenia, nie zadaniem serwisowym. Testy
 * pilnują tego, co najłatwiej zepsuć po cichu: który pomiar jest
 * obowiązujący, co znaczy brak pomiaru i czy wygaśnięcie naprawdę blokuje.
 */

const NOW = new Date('2026-09-19T12:00:00Z')

function record(overrides: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    kind: 'camera_extrinsics',
    measuredAt: new Date('2026-09-01T08:00:00Z'),
    validUntil: new Date('2026-12-01T08:00:00Z'),
    ...overrides,
  }
}

describe('evaluateCalibration', () => {
  it('komplet ważnych pomiarów dopuszcza robota', () => {
    const verdict = evaluateCalibration(
      ['camera_extrinsics', 'joint_offsets'],
      [record(), record({ kind: 'joint_offsets' })],
      NOW,
    )
    expect(verdict.complete).toBe(true)
    expect(verdict.blocking).toEqual([])
    expect(verdict.reason).toBeUndefined()
  })

  it('brak choćby jednego wymaganego pomiaru blokuje', () => {
    const verdict = evaluateCalibration(['camera_extrinsics', 'joint_offsets'], [record()], NOW)
    expect(verdict.complete).toBe(false)
    expect(verdict.blocking).toEqual(['joint_offsets'])
    expect(verdict.reason).toContain('joint_offsets')
  })

  it('pomiar wygasły blokuje tak samo, jak brak pomiaru', () => {
    const verdict = evaluateCalibration(
      ['camera_extrinsics'],
      [record({ validUntil: new Date('2026-09-18T08:00:00Z') })],
      NOW,
    )
    expect(verdict.complete).toBe(false)
    expect(verdict.statuses[0].state).toBe('expired')
    expect(verdict.statuses[0].daysLeft).toBeLessThan(0)
  })

  it('odróżnia brak pomiaru od pomiaru unieważnionego', () => {
    // „Nigdy nie zrobiono" i „zrobiono, po czym ktoś świadomie odwołał" to dwie
    // różne sytuacje dla technika i muszą wyglądać inaczej na ekranie.
    const brak = evaluateCalibration(['joint_offsets'], [], NOW)
    expect(brak.statuses[0].state).toBe('missing')

    const odwolany = evaluateCalibration(
      ['camera_extrinsics'],
      [record({ invalidatedAt: new Date('2026-09-10T00:00:00Z') })],
      NOW,
    )
    expect(odwolany.statuses[0].state).toBe('invalidated')
    expect(odwolany.complete).toBe(false)
  })

  it('obowiązuje pomiar NAJNOWSZY, a nie ten o najdalszej dacie ważności', () => {
    // Rekalibracja po uderzeniu w robota bywa krótsza niż poprzednia, a mimo to
    // jest tą obowiązującą. Sortowanie po ważności przemyciłoby stary pomiar
    // i dopuściło maszynę, której geometria właśnie się zmieniła.
    const stary = record({
      measuredAt: new Date('2026-09-01T08:00:00Z'),
      validUntil: new Date('2027-01-01T08:00:00Z'),
    })
    const nowy = record({
      measuredAt: new Date('2026-09-18T08:00:00Z'),
      validUntil: new Date('2026-09-19T06:00:00Z'), // już wygasł
    })
    const verdict = evaluateCalibration(['camera_extrinsics'], [stary, nowy], NOW)
    expect(verdict.complete).toBe(false)
    expect(verdict.statuses[0].state).toBe('expired')
  })

  it('kolejność wejścia nie zmienia werdyktu', () => {
    const a = record({ measuredAt: new Date('2026-09-01T08:00:00Z') })
    const b = record({ measuredAt: new Date('2026-09-15T08:00:00Z') })
    const wprzod = evaluateCalibration(['camera_extrinsics'], [a, b], NOW)
    const wstecz = evaluateCalibration(['camera_extrinsics'], [b, a], NOW)
    expect(wprzod.statuses[0].validUntil).toEqual(wstecz.statuses[0].validUntil)
  })

  it('unieważniony pomiar nie przesłania starszego, wciąż ważnego', () => {
    const wazny = record({ measuredAt: new Date('2026-09-01T08:00:00Z') })
    const odwolany = record({
      measuredAt: new Date('2026-09-15T08:00:00Z'),
      invalidatedAt: new Date('2026-09-16T00:00:00Z'),
    })
    const verdict = evaluateCalibration(['camera_extrinsics'], [wazny, odwolany], NOW)
    expect(verdict.complete).toBe(true)
  })

  it('pomiar wygasający dokładnie teraz już nie jest ważny', () => {
    const verdict = evaluateCalibration(['camera_extrinsics'], [record({ validUntil: NOW })], NOW)
    expect(verdict.complete).toBe(false)
  })

  it('pusta lista wymagań dopuszcza - rewizja bez kalibracji jest dozwolona', () => {
    expect(evaluateCalibration([], [], NOW).complete).toBe(true)
  })

  it('pomiary spoza listy wymagań nie wpływają na werdykt', () => {
    const verdict = evaluateCalibration(
      ['camera_extrinsics'],
      [record(), record({ kind: 'cos_zupelnie_innego', validUntil: new Date('2020-01-01') })],
      NOW,
    )
    expect(verdict.complete).toBe(true)
  })
})

describe('expiringWithin', () => {
  it('wskazuje pomiary do odnowienia, zanim robot stanie', () => {
    const verdict = evaluateCalibration(
      ['camera_extrinsics', 'joint_offsets'],
      [
        record({ validUntil: new Date('2026-09-24T12:00:00Z') }), // za 5 dni
        record({ kind: 'joint_offsets', validUntil: new Date('2026-12-01T08:00:00Z') }),
      ],
      NOW,
    )
    const wkrotce = expiringWithin(verdict, 7)
    expect(wkrotce.map((s) => s.kind)).toEqual(['camera_extrinsics'])
  })

  it('nie zgłasza tego, co już wygasło - to jest blokada, nie ostrzeżenie', () => {
    const verdict = evaluateCalibration(
      ['camera_extrinsics'],
      [record({ validUntil: new Date('2026-09-10T12:00:00Z') })],
      NOW,
    )
    expect(expiringWithin(verdict, 7)).toEqual([])
    expect(verdict.blocking).toEqual(['camera_extrinsics'])
  })
})

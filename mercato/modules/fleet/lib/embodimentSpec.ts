import { createHash } from 'node:crypto'

/**
 * Opis embodimentu jako plik, walidowany i skracany deterministycznie.
 *
 * Powód powstania jest konkretny: do tej pory `spec_digest` był **deklarowany**
 * przez wgrywającego. Odcisk, który podaje ten sam, kto podaje specyfikację,
 * nie stwierdza niczego - porównuje deklarację sam ze sobą. Tutaj odcisk jest
 * **liczony** z kanonicznej postaci opisu, więc zmiana jednego przełożenia
 * w jednym stawie daje inny odcisk i unieważnia zgodność polityk.
 *
 * Drugi powód: SO-101 jest ramieniem dobrze udokumentowanym i ma być wzorcem.
 * Ramiona gorzej udokumentowane wypełni się tym samym formularzem, a miejsca,
 * których nikt nie zna, zostaną jawnie oznaczone jako `unknown` - zamiast być
 * po cichu zgadnięte. To jest cała idea tego formatu: **niewiedza ma być
 * widoczna w danych, a nie schowana w wartości domyślnej.**
 */

export const UNKNOWN = 'unknown'

export type EmbodimentJoint = {
  name: string
  motorId?: number
  model?: string
  gearRatio?: string
}

export type EmbodimentSpec = {
  embodimentKey: string
  revision: number
  name: string
  provenance?: {
    sourcedFrom?: string
    verifiedAgainstHardware?: boolean
    sources?: string[]
  }
  kinematics: { type: string; dofCount: number; [key: string]: unknown }
  actuators: { joints: EmbodimentJoint[]; [key: string]: unknown }
  requiredCalibrations: string[]
  safetyLayer?: Record<string, unknown>
  [key: string]: unknown
}

export type SpecProblem = { path: string; reason: string; severity: 'error' | 'unknown_field' }

export type SpecVerdict = {
  valid: boolean
  /** Czy opis nadaje się do dopuszczenia polityki, czy tylko do ewidencji. */
  complete: boolean
  problems: SpecProblem[]
  unknownFields: string[]
}

/** Wszystkie ścieżki, pod którymi opis jawnie przyznaje się do niewiedzy. */
export function collectUnknowns(value: unknown, path = ''): string[] {
  if (value === UNKNOWN) return [path || '(root)']
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectUnknowns(item, `${path}[${index}]`))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectUnknowns(child, path ? `${path}.${key}` : key),
    )
  }
  return []
}

export function validateEmbodimentSpec(input: unknown): SpecVerdict {
  const problems: SpecProblem[] = []
  const spec = (input ?? {}) as Partial<EmbodimentSpec>

  const wymagane: Array<[string, unknown]> = [
    ['embodimentKey', spec.embodimentKey],
    ['revision', spec.revision],
    ['name', spec.name],
    ['kinematics', spec.kinematics],
    ['actuators', spec.actuators],
    ['requiredCalibrations', spec.requiredCalibrations],
  ]
  for (const [path, value] of wymagane) {
    if (value === undefined || value === null) {
      problems.push({ path, reason: 'pole wymagane', severity: 'error' })
    }
  }

  if (typeof spec.revision === 'number' && (!Number.isInteger(spec.revision) || spec.revision < 1)) {
    problems.push({ path: 'revision', reason: 'rewizja musi być dodatnią liczbą całkowitą', severity: 'error' })
  }

  const joints = spec.actuators?.joints
  const dof = spec.kinematics?.dofCount

  if (!Array.isArray(joints) || joints.length === 0) {
    problems.push({ path: 'actuators.joints', reason: 'opis musi wymieniać stawy', severity: 'error' })
  } else {
    const nazwy = new Set<string>()
    joints.forEach((joint, index) => {
      if (!joint?.name) {
        problems.push({ path: `actuators.joints[${index}].name`, reason: 'staw bez nazwy', severity: 'error' })
        return
      }
      if (nazwy.has(joint.name)) {
        // Zduplikowana nazwa stawu znaczy, że ktoś kopiował wiersz i nie poprawił -
        // a przestrzeń akcji polityki jest indeksowana właśnie nazwami.
        problems.push({
          path: `actuators.joints[${index}].name`,
          reason: `nazwa stawu ${joint.name} powtarza się`,
          severity: 'error',
        })
      }
      nazwy.add(joint.name)
    })

    if (typeof dof === 'number' && dof !== joints.length) {
      /**
       * Rozjazd liczby stopni swobody z liczbą stawów jest najtańszą kontrolą
       * zdrowego rozsądku, jaka istnieje - i najczęściej łapie opis skopiowany
       * z innego ramienia i poprawiony tylko w połowie.
       */
      problems.push({
        path: 'kinematics.dofCount',
        reason: `dofCount=${dof} nie zgadza się z liczbą stawów (${joints.length})`,
        severity: 'error',
      })
    }
  }

  if (spec.requiredCalibrations !== undefined && !Array.isArray(spec.requiredCalibrations)) {
    problems.push({ path: 'requiredCalibrations', reason: 'oczekiwano listy', severity: 'error' })
  }

  const unknownFields = collectUnknowns(spec)
  for (const path of unknownFields) {
    problems.push({ path, reason: 'wartość nieznana z dokumentacji - wymaga pomiaru', severity: 'unknown_field' })
  }

  const errors = problems.filter((p) => p.severity === 'error')

  return {
    valid: errors.length === 0,
    /**
     * „Kompletny" znaczy: nadaje się do dopuszczenia polityki. Opis
     * z jawnymi lukami wolno zaewidencjonować - bo inwentaryzacja ramienia,
     * którego nikt do końca nie zna, jest właśnie tym, od czego zaczyna się
     * wdrożenie - ale nie wolno na jego podstawie dopuścić polityki do ruchu.
     */
    complete: errors.length === 0 && unknownFields.length === 0,
    problems,
    unknownFields,
  }
}

/**
 * Kanoniczna postać opisu: klucze posortowane, wcięcia usunięte.
 *
 * Z odcisku wypadają **prowenancja i nazwa własna**. To nie jest niedopatrzenie:
 * dopisanie odnośnika do źródła albo poprawienie literówki w nazwie nie zmienia
 * fizyki ramienia, a zmieniony odcisk unieważniłby zgodność wszystkich polityk.
 * Odcisk ma się zmieniać wtedy, gdy zmienia się **kontrakt**, a nie metryczka.
 */
export function canonicalSpecForm(spec: EmbodimentSpec): string {
  const { provenance: _p, name: _n, $schema: _s, ...istotne } = spec as Record<string, unknown>
  return JSON.stringify(sortDeep(istotne))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function computeSpecDigest(spec: EmbodimentSpec): string {
  return createHash('sha256').update(canonicalSpecForm(spec), 'utf8').digest('hex')
}

/**
 * Zgodność polityki ze sprzętem - sprawdzana przed wdrożeniem, nie po ruchu ramienia.
 *
 * To jest cały powód istnienia wiązania wersji z **rewizją embodimentu**
 * zamiast z robotem. Robot jest egzemplarzem; kontraktem jest rewizja.
 * Sprawdzenie musi być możliwe w chwili rejestracji wersji, kiedy żaden robot
 * jeszcze nie został wskazany.
 *
 * Czysta funkcja: rozstrzyga, czy ton metalu wolno ruszyć tym sterownikiem.
 */

export type EmbodimentContract = {
  id: string
  embodimentKey: string
  revision: number
  specDigest: string
  dofCount?: number | null
}

export type CompatibilityClaim = {
  /** Rodzina zadeklarowana przy polityce. */
  policyEmbodimentKey: string
  /**
   * Odcisk kontraktu, pod który polityka została wytrenowana.
   *
   * Przychodzi od wgrywającego, a nie jest odczytywany z bazy - o to chodzi.
   * Gdyby był odczytywany, kontrola porównywałaby wartość samą ze sobą
   * i zawsze przechodziła. Rozjazd wychodzi wyłącznie wtedy, gdy obie strony
   * mówią niezależnie.
   */
  declaredSpecDigest: string
  observationDim?: number | null
  actionDim?: number | null
  /** Liczba stopni swobody, na której polityka była uczona. */
  trainedDofCount?: number | null
}

export type CompatibilityVerdict = {
  compatible: boolean
  /** Powód odmowy - nazwany, nie „walidacja nie przeszła". */
  reason?: string
  /** Kod maszynowy dla wywołującego, żeby nie parsował polskiego zdania. */
  code?: 'embodiment_key_mismatch' | 'spec_digest_mismatch' | 'dof_mismatch' | 'no_embodiment'
}

/**
 * Trzy pytania po kolei; kolejność niesie sens komunikatu.
 *
 * 1. Czy w ogóle wskazano rewizję.
 * 2. Czy to ta rodzina sprzętu.
 * 3. Czy kontrakt jest bit w bit ten sam.
 *
 * Kontrola stopni swobody jest ostatnia i najsłabsza - zgodne DOF przy
 * niezgodnym `spec_digest` nie znaczy nic, ale niezgodne DOF przy zgodnym
 * skrócie oznacza, że ktoś ręcznie podmienił skrót i warto o tym powiedzieć.
 */
export function checkEmbodimentCompatibility(
  contract: EmbodimentContract | null,
  claim: CompatibilityClaim,
): CompatibilityVerdict {
  if (!contract) {
    return {
      compatible: false,
      code: 'no_embodiment',
      reason:
        'polityka bez zadeklarowanej rewizji embodimentu nie daje się zapisać - nie istniałoby miejsce, w którym da się stwierdzić, na czym wolno ją uruchomić',
    }
  }

  if (contract.embodimentKey !== claim.policyEmbodimentKey) {
    return {
      compatible: false,
      code: 'embodiment_key_mismatch',
      reason: `polityka jest dla rodziny ${claim.policyEmbodimentKey}, a wskazana rewizja należy do ${contract.embodimentKey}`,
    }
  }

  if (contract.specDigest !== claim.declaredSpecDigest) {
    return {
      compatible: false,
      code: 'spec_digest_mismatch',
      reason: `odcisk kontraktu embodimentu nie zgadza się: rewizja ${contract.embodimentKey}@r${contract.revision} ma ${contract.specDigest}, a polityka była uczona pod ${claim.declaredSpecDigest}`,
    }
  }

  if (
    claim.trainedDofCount != null &&
    contract.dofCount != null &&
    claim.trainedDofCount !== contract.dofCount
  ) {
    return {
      compatible: false,
      code: 'dof_mismatch',
      reason: `liczba stopni swobody nie zgadza się: rewizja ma ${contract.dofCount}, polityka uczona na ${claim.trainedDofCount}`,
    }
  }

  return { compatible: true }
}

/**
 * Czy wersja w tym statusie daje się w ogóle wdrożyć.
 *
 * Trzymane tutaj, a nie w module wdrożeń, z tego samego powodu, dla którego
 * `mayRunPolicy` siedzi w cyklu życia robota: dwa moduły z dwiema wersjami
 * tej samej prawdy w końcu się rozjeżdżają.
 */
export function mayBeDeployed(status: string): boolean {
  return status === 'released'
}

/**
 * Co na tym sprzęcie naprawdę pójdzie.
 *
 * Funkcja istnieje, bo arkusz danych akceleratora i jego rzeczywista wydajność
 * to dwie różne rzeczy, a różnica jest systematyczna, nie losowa.
 *
 * **Dla wnioskowania autoregresyjnego wąskim gardłem jest przepustowość
 * pamięci, nie moc obliczeniowa.** Wygenerowanie jednego tokenu wymaga
 * przeczytania wag z pamięci; przy modelu gęstym - wszystkich, przy modelu
 * z mieszanką ekspertów - tylko aktywnych. Nagłówkowy petaflop nie pomaga,
 * gdy układ czeka na pamięć.
 *
 * Liczby dla DGX Spark, przeciw którym ta funkcja była pisana: 128 GB pamięci
 * zunifikowanej LPDDR5X, **273 GB/s** przepustowości, 1 PFLOPS w FP4.
 * Niezależne pomiary zgodnie wskazują, że to przepustowość, a nie petaflop,
 * rozstrzyga o wydajności - i że modele powyżej ~30 mld parametrów gęstych
 * „mieszczą się, ale są wolne".
 *
 * Wniosek projektowy, który z tego płynie i który trzeba nazwać: taka maszyna
 * jest **węzłem treningowym i ewaluacyjnym**, a nie serwerem wnioskowania
 * czasu rzeczywistego dla hali.
 */

export type NodeCapability = {
  /** Pamięć dostępna dla modelu, w gigabajtach. */
  memoryGb: number
  /** Przepustowość pamięci w GB/s - liczba, która realnie rozstrzyga. */
  memoryBandwidthGbs: number
  /** Moc obliczeniowa w TFLOPS przy precyzji, w której model faktycznie liczy. */
  computeTflops: number
  /**
   * Ułamek przepustowości teoretycznej osiągany w praktyce.
   *
   * Domyślne 0,45 nie jest ostrożnościowe „na oko": pomiary DGX Spark dla
   * modelu z mieszanką ekspertów dają rząd 40% roofline'u. Podanie 1,0
   * oznacza liczenie wydajności, której nikt nigdy nie zmierzył.
   */
  bandwidthEfficiency?: number
}

export type DecodeWorkload = {
  /** Parametry **aktywne** na token, w miliardach. Dla modelu gęstego = wszystkie. */
  activeParamsB: number
  /** Parametry łącznie, w miliardach - decyduje, czy model w ogóle się zmieści. */
  totalParamsB: number
  /** Bajty na parametr: 0,5 dla FP4, 1 dla FP8/INT8, 2 dla FP16. */
  bytesPerParam: number
  /** Narzut pamięci poza wagami (KV cache, aktywacje), w gigabajtach. */
  overheadGb?: number
}

export type VisionWorkload = {
  /** Rozmiar wag detektora w megabajtach. */
  weightsMb: number
  /** Operacje zmiennoprzecinkowe na klatkę, w GFLOP. */
  gflopsPerFrame: number
  /** Ile strumieni ma obsłużyć ten węzeł. */
  streams: number
  /** Docelowa liczba klatek na sekundę na strumień. */
  targetFps: number
}

export type Bound = 'capacity' | 'memory_bandwidth' | 'compute'

export type CapacityVerdict = {
  fits: boolean
  bound: Bound
  /** Tokeny na sekundę albo klatki na sekundę - zależnie od obciążenia. */
  estimatedRate: number | null
  requiredMemoryGb: number
  headroomGb: number
  reason: string
}

const DEFAULT_EFFICIENCY = 0.45
/** Ułamek szczytowych TFLOPS osiągany realnie - tak samo jak przy pamięci. */
const DEFAULT_COMPUTE_EFFICIENCY = 0.35

export function estimateDecode(node: NodeCapability, workload: DecodeWorkload): CapacityVerdict {
  const efficiency = node.bandwidthEfficiency ?? DEFAULT_EFFICIENCY
  const weightsGb = workload.totalParamsB * workload.bytesPerParam
  const requiredMemoryGb = weightsGb + (workload.overheadGb ?? 0)
  const headroomGb = node.memoryGb - requiredMemoryGb

  if (headroomGb < 0) {
    // Brak miejsca jest granicą twardą - żadna przepustowość tego nie naprawi.
    return {
      fits: false,
      bound: 'capacity',
      estimatedRate: null,
      requiredMemoryGb,
      headroomGb,
      reason:
        `Model wymaga ${requiredMemoryGb.toFixed(1)} GB, a węzeł ma ${node.memoryGb} GB. ` +
        'Brakuje miejsca - to granica twarda, nie kwestia wydajności.',
    }
  }

  /*
   * Rdzeń rachunku: jeden token = jeden przebieg przez **aktywne** wagi.
   * Rozróżnienie aktywnych od wszystkich jest tu decydujące. Model
   * z mieszanką ekspertów o 120 mld parametrów, z których na token pracuje
   * 5 mld, czyta z pamięci dwudziestokrotnie mniej niż gęsty model tej samej
   * wielkości - i dlatego bywa użyteczny tam, gdzie gęsty nie jest.
   */
  const activeBytesGb = workload.activeParamsB * workload.bytesPerParam
  const tokensPerSecond = (node.memoryBandwidthGbs * efficiency) / Math.max(0.001, activeBytesGb)

  return {
    fits: true,
    bound: 'memory_bandwidth',
    estimatedRate: Number(tokensPerSecond.toFixed(1)),
    requiredMemoryGb,
    headroomGb,
    reason:
      `Model mieści się (${requiredMemoryGb.toFixed(1)} z ${node.memoryGb} GB). ` +
      `Ograniczeniem jest przepustowość: ${activeBytesGb.toFixed(2)} GB wag aktywnych na token ` +
      `przy ${node.memoryBandwidthGbs} GB/s i sprawności ${(efficiency * 100).toFixed(0)}% ` +
      `daje około ${tokensPerSecond.toFixed(1)} tok/s. Moc obliczeniowa nie jest tu wąskim gardłem.`,
  }
}

export function estimateVision(node: NodeCapability, workload: VisionWorkload): CapacityVerdict {
  const requiredMemoryGb = (workload.weightsMb / 1024) * workload.streams
  const headroomGb = node.memoryGb - requiredMemoryGb

  if (headroomGb < 0) {
    return {
      fits: false,
      bound: 'capacity',
      estimatedRate: null,
      requiredMemoryGb,
      headroomGb,
      reason: `${workload.streams} strumieni po ${workload.weightsMb} MB nie mieści się w ${node.memoryGb} GB.`,
    }
  }

  /*
   * Przy detektorach wąskie gardło się **odwraca**. Model o wagach rzędu
   * stu megabajtów czyta się z pamięci w ułamku milisekundy, więc liczy się
   * moc obliczeniowa na klatkę, a nie przepustowość. Funkcja, która dla
   * każdego obciążenia zwraca „ograniczeniem jest pamięć", myliłaby się tu
   * w drugą stronę i kazała kupować pamięć zamiast rdzeni.
   */
  const bandwidthFps =
    ((node.memoryBandwidthGbs * (node.bandwidthEfficiency ?? DEFAULT_EFFICIENCY)) /
      (workload.weightsMb / 1024))
  const computeFps = (node.computeTflops * DEFAULT_COMPUTE_EFFICIENCY * 1000) / Math.max(0.001, workload.gflopsPerFrame)

  const totalFps = Math.min(bandwidthFps, computeFps)
  const perStream = totalFps / Math.max(1, workload.streams)
  const bound: Bound = computeFps <= bandwidthFps ? 'compute' : 'memory_bandwidth'
  const wystarczy = perStream >= workload.targetFps

  return {
    fits: wystarczy,
    bound,
    estimatedRate: Number(perStream.toFixed(1)),
    requiredMemoryGb,
    headroomGb,
    reason: wystarczy
      ? `Około ${perStream.toFixed(0)} kl./s na strumień przy ${workload.streams} strumieniach ` +
        `(wymagane ${workload.targetFps}). Ograniczeniem jest ${bound === 'compute' ? 'moc obliczeniowa' : 'przepustowość pamięci'}.`
      : `Około ${perStream.toFixed(1)} kl./s na strumień, a potrzeba ${workload.targetFps}. ` +
        `Ograniczeniem jest ${bound === 'compute' ? 'moc obliczeniowa' : 'przepustowość pamięci'} - ` +
        'zmniejsz liczbę strumieni, rozdzielczość albo częstość próbkowania.',
  }
}

/**
 * Role, których węzeł obliczeniowy ogólnego przeznaczenia **nie może** pełnić.
 *
 * To nie jest lista dobrych praktyk. Warstwa zatrzymująca maszynę musi być
 * deterministyczna i niezależna od tego, co robi polityka - a wieloprocesowy
 * system ogólnego przeznaczenia z akceleratorem nie daje ani determinizmu,
 * ani niezależności. Kuszenie jest realne i przewidywalne: jak już stoi
 * mocna maszyna, wszystko chce na niej wylądować.
 */
export const FORBIDDEN_NODE_ROLES = ['safety_function', 'emergency_stop', 'protective_stop'] as const

export const NODE_ROLES = [
  'training',
  'evaluation',
  'vision_inference',
  'policy_inference',
  'simulation',
  'data_processing',
] as const

export type NodeRole = (typeof NODE_ROLES)[number]

export function checkNodeRoles(roles: string[]): { allowed: boolean; rejected: string[]; reason: string } {
  const rejected = (roles ?? []).filter((role) =>
    (FORBIDDEN_NODE_ROLES as readonly string[]).includes(String(role).trim().toLowerCase()),
  )
  if (rejected.length) {
    return {
      allowed: false,
      rejected,
      reason:
        `Węzeł obliczeniowy nie może pełnić roli: ${rejected.join(', ')}. ` +
        'Zatrzymanie maszyny musi być deterministyczne i niezależne od polityki - realizuje je sterownik ' +
        'celi albo obwód bezpieczeństwa, nigdy współdzielona maszyna ogólnego przeznaczenia z akceleratorem.',
    }
  }

  const nieznane = (roles ?? []).filter((role) => !(NODE_ROLES as readonly string[]).includes(String(role)))
  if (nieznane.length) {
    return { allowed: false, rejected: nieznane, reason: `Nieznane role węzła: ${nieznane.join(', ')}.` }
  }

  return { allowed: true, rejected: [], reason: 'Role dopuszczone.' }
}

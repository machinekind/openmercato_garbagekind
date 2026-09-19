import {
  calibrationStatus,
  isNotable,
  lifecycleStatus,
  linkStatus,
  SHORT_LABEL_MAX,
  statusVocabulary,
  worstOf,
  type CalibrationState,
  type LinkState,
  type StatusDescriptor,
} from '../lib/status'
import { SEVERITY_PRIORITY, tokensCss, type Severity } from '../lib/tokens'

/**
 * Reguły systemu wizualnego, egzekwowane testem zamiast zaleceniem.
 *
 * Zalecenie „nie polegaj na samym kolorze" trafia do dokumentu, którego nikt
 * nie czyta przy dodawaniu nowego stanu. Test przy tym samym dodaniu
 * po prostu nie przechodzi.
 */

const WSZYSTKIE_STANY: string[] = [
  'registered', 'commissioning', 'ready', 'operational',
  'maintenance', 'quarantined', 'decommissioning', 'decommissioned',
]
const KALIBRACJE: CalibrationState[] = ['valid', 'expiring', 'blocked', 'unknown']
const LACZNOSCI: LinkState[] = ['online', 'late', 'lost', 'never_seen', 'absent', 'layer_unavailable']

function wszystkieDeskryptory(): StatusDescriptor[] {
  return [
    ...WSZYSTKIE_STANY.map(lifecycleStatus),
    lifecycleStatus('zupelnie-nieznany'),
    ...KALIBRACJE.map((k) => calibrationStatus(k, 3)),
    ...LACZNOSCI.map((l) => linkStatus(l, 120)),
  ]
}

describe('KOLOR NIGDY SAM', () => {
  it('każdy stan odbiegający od normy ma kształt', () => {
    for (const d of wszystkieDeskryptory()) {
      if (d.severity === 'normal') continue
      expect(d.glyph).not.toBe('none')
    }
  })

  it('FORMA KRÓTKA JEST NAPRAWDĘ KRÓTKA — inaczej kafelek i tak ją utnie', () => {
    // Automatyczne cięcie daje „Agent nigdy się …", z czego nie wynika nic.
    // Człowiek piszący etykietę potrafi skrócić ją tak, żeby coś znaczyła —
    // ale tylko jeśli coś go do tego zmusi.
    for (const d of wszystkieDeskryptory()) {
      expect(d.short.length).toBeLessThanOrEqual(SHORT_LABEL_MAX)
      expect(d.short.trim().length).toBeGreaterThan(0)
    }
  })

  it('każdy stan ma etykietę tekstową', () => {
    for (const d of wszystkieDeskryptory()) {
      expect(d.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('STAN NORMALNY NIE MA GLIFU — nie zużywa uwagi na „w porządku"', () => {
    // Ekran, na którym każda maszyna nosi znaczek „w porządku", zużywa całą
    // uwagę na potwierdzanie, że nic się nie dzieje.
    for (const d of wszystkieDeskryptory()) {
      if (d.severity !== 'normal') continue
      expect(d.glyph).toBe('none')
    }
  })

  it('każdy kod jest unikalny w obrębie swojej rodziny', () => {
    const kody = wszystkieDeskryptory().map((d) => d.code)
    const rodziny = new Map<string, Set<string>>()
    for (const kod of kody) {
      const [rodzina] = kod.split('.')
      const zbior = rodziny.get(rodzina) ?? new Set()
      zbior.add(kod)
      rodziny.set(rodzina, zbior)
    }
    expect(rodziny.get('link')!.size).toBe(LACZNOSCI.length)
  })
})

describe('praca to norma', () => {
  it('robot w ruchu i gotowy nie dostają koloru', () => {
    // Najważniejsza zmiana wobec poprzedniej wersji ekranu: pięć pracujących
    // maszyn dawało ścianę zieleni, w której czerwony musiał się bić o uwagę.
    expect(lifecycleStatus('operational').severity).toBe('normal')
    expect(lifecycleStatus('ready').severity).toBe('normal')
    expect(isNotable(lifecycleStatus('operational'))).toBe(false)
  })

  it('kalibracja ważna i łączność w normie też nie', () => {
    expect(calibrationStatus('valid').severity).toBe('normal')
    expect(linkStatus('online').severity).toBe('normal')
  })

  it('brak wymagań kalibracyjnych to norma, nie niewiedza', () => {
    // Rewizja embodimentu nie deklaruje pomiarów — to kompletna informacja.
    expect(calibrationStatus('unknown').severity).toBe('normal')
  })
})

describe('niewiedza waży więcej niż ostrzeżenie', () => {
  it('brak wpisanego agenta to „unknown", nie „normal" i nie „advisory"', () => {
    const d = linkStatus('absent')
    expect(d.severity).toBe('unknown')
    expect(SEVERITY_PRIORITY.unknown).toBeGreaterThan(SEVERITY_PRIORITY.advisory)
  })

  it('stan spoza słownika nie znika, tylko wypływa jako nierozpoznany', () => {
    const d = lifecycleStatus('cos_nowego_w_rejestrze')
    expect(d.severity).toBe('unknown')
    expect(d.detail).toMatch(/cos_nowego_w_rejestrze/)
  })
})

describe('worstOf', () => {
  it('alarm wypiera ostrzeżenie i niewiedzę', () => {
    const wynik = worstOf([
      linkStatus('absent'),
      calibrationStatus('expiring', 5),
      lifecycleStatus('quarantined'),
    ])
    expect(wynik.code).toBe('lifecycle.quarantined')
  })

  it('niewiedza wypiera ostrzeżenie', () => {
    const wynik = worstOf([calibrationStatus('expiring', 2), linkStatus('absent')])
    expect(wynik.code).toBe('link.absent')
  })

  it('same stany normalne dają stan normalny', () => {
    expect(worstOf([lifecycleStatus('operational'), linkStatus('online')]).severity).toBe('normal')
  })

  it('pusta lista nie wywraca się, tylko mówi, że nie wie', () => {
    expect(worstOf([]).severity).toBe('normal')
    expect(worstOf([]).label.length).toBeGreaterThan(0)
  })
})

describe('legenda', () => {
  it('generuje się ze słownika, nie z ręcznej listy', () => {
    // Ręczna legenda rozjechała się w tym projekcie dwa razy.
    const slownik = statusVocabulary()
    expect(slownik.length).toBeGreaterThan(10)
    for (const d of slownik) expect(d.label.trim().length).toBeGreaterThan(0)
  })

  it('zawiera wszystkie stany łączności', () => {
    const kody = new Set(statusVocabulary().map((d) => d.code))
    for (const l of LACZNOSCI) {
      if (l === 'online') continue // norma nie trafia do legendy
      expect(kody.has(linkStatus(l).code)).toBe(true)
    }
  })
})

describe('żetony', () => {
  it('definiują kolor dla każdej wagi ważności', () => {
    const css = tokensCss()
    for (const s of Object.keys(SEVERITY_PRIORITY) as Severity[]) {
      expect(css).toContain(`--hmi-${s}:`)
    }
  })

  it('obsługują tryb ciemny i przez preferencję systemu, i przez wymuszenie', () => {
    // Obsłużenie tylko jednego kanału daje ekran, który w połowie przypadków
    // ma kolory z drugiego motywu.
    const css = tokensCss()
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain('[data-theme="dark"]')
  })
})

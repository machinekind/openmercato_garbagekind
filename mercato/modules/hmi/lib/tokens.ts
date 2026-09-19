/**
 * Żetony wizualne systemu HMI.
 *
 * Podstawa nie jest kwestią gustu, tylko przeniesieniem doktryny
 * **wysokowydajnego HMI** (ISA-101) na ekran w przeglądarce:
 *
 * 1. **Stan normalny jest szary.** Kolor jest zarezerwowany dla odstępstwa.
 *    Ekran, na którym wszystko świeci na zielono, uczy operatora, że kolor
 *    nic nie znaczy — a wtedy czerwony musi się bić o uwagę z pięcioma
 *    zielonymi zamiast po prostu wyskoczyć z tła.
 * 2. **Kolor nigdy sam.** Każdy stan odbiegający od normy ma dodatkowo
 *    **kształt** i **tekst**. Wymuszone testem, nie zaleceniem: deskryptor
 *    bez glifu albo bez etykiety nie przechodzi.
 * 3. **Hierarchia ważności jest jedna** i ta sama na wszystkich ekranach.
 *
 * Czego **nie** przenosimy dosłownie: tła RGB 192,192,192 z dyspozytorni.
 * To ekran w panelu administracyjnym, który ma tryb jasny i ciemny, więc
 * bierzemy zasadę (norma neutralna, kolor = odstępstwo), a nie konkretną
 * szarość. Udawanie sterowni w panelu ERP byłoby kopiowaniem formy zamiast
 * treści.
 */

export type Severity = 'normal' | 'advisory' | 'alarm' | 'action' | 'suppressed' | 'unknown'

/**
 * Waga ważności — im wyżej, tym bardziej wypycha inne stany z kafelka.
 *
 * `unknown` stoi **wyżej niż `advisory`** i jest to decyzja, nie przeoczenie:
 * „nie wiem, co się dzieje z tą maszyną" jest gorszą wiadomością niż
 * „wiem i za dwa tygodnie trzeba będzie coś zrobić".
 */
export const SEVERITY_PRIORITY: Record<Severity, number> = {
  normal: 0,
  suppressed: 1,
  advisory: 2,
  unknown: 3,
  action: 4,
  alarm: 5,
}

/**
 * Paleta. Wartości w HSL, żeby jedna definicja obsłużyła oba tryby: w trybie
 * ciemnym zmienia się jasność, nie odcień — barwa niesie znaczenie i musi
 * zostać ta sama.
 */
export const SEVERITY_COLOR: Record<Severity, { light: string; dark: string }> = {
  // Norma nie ma własnego koloru — bierze kolor tekstu z motywu, przygaszony.
  normal: { light: 'hsl(215 16% 47%)', dark: 'hsl(215 14% 62%)' },
  suppressed: { light: 'hsl(188 70% 35%)', dark: 'hsl(188 60% 55%)' },
  advisory: { light: 'hsl(38 92% 40%)', dark: 'hsl(38 92% 58%)' },
  unknown: { light: 'hsl(258 60% 50%)', dark: 'hsl(258 70% 70%)' },
  action: { light: 'hsl(217 85% 45%)', dark: 'hsl(217 90% 65%)' },
  alarm: { light: 'hsl(0 72% 44%)', dark: 'hsl(0 80% 62%)' },
}

/** Nazwy zmiennych CSS — jedno źródło, żeby literówka nie tworzyła cichego czarnego. */
export const cssVar = (severity: Severity): string => `var(--hmi-${severity})`

/**
 * Siatka odstępów w pikselach.
 *
 * Krok czwórkowy, bo wszystko na tym ekranie jest małe: kafelek robota ma
 * kilkadziesiąt pikseli i ósemkowa siatka wymusiłaby albo za duże odstępy,
 * albo łamanie siatki.
 */
export const SPACE = { xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 24 } as const

export const TYPE = {
  /** Etykiety w rysunku: numer seryjny, kod celi. */
  identifier: { size: 11, weight: 600, tracking: 0.02 },
  /** Opis stanu pod identyfikatorem. */
  status: { size: 10, weight: 500, tracking: 0 },
  /** Liczby wyniku. */
  metric: { size: 12, weight: 600, tracking: 0 },
  /** Podpisy i legenda. */
  caption: { size: 10, weight: 400, tracking: 0.01 },
} as const

export const RADIUS = { tile: 3, cell: 4, badge: 2 } as const

export const STROKE = { hairline: 1, normal: 1.5, emphasis: 2.5 } as const

/**
 * Wymiary kafelka maszyny w pikselach ekranu.
 *
 * `minWidth` bierze się z **czytelności opisu stanu**, nie z długości numeru
 * seryjnego. Numer mieści się w 76 px i przy takiej szerokości układ potrafi
 * upchnąć trzy kolumny — tyle że etykieta „Agent nigdy się nie odezwał"
 * skraca się wtedy do „Agent nigdy s…". Kafelek zastąpił kropkę właśnie po to,
 * żeby stan dało się przeczytać, a nie odgadnąć z barwy.
 */
export const TILE = { height: 28, minWidth: 118, gap: 6 } as const

/**
 * Deklaracja zmiennych CSS wstrzykiwana raz na stronę.
 *
 * Tryb ciemny przez `@media` **oraz** przez atrybut `data-theme`, bo panel
 * pozwala wymusić motyw niezależnie od ustawień systemu — obsłużenie tylko
 * jednego z tych kanałów daje ekran, który w połowie przypadków ma kolory
 * z drugiego motywu.
 */
export function tokensCss(): string {
  const light = (Object.keys(SEVERITY_COLOR) as Severity[])
    .map((s) => `  --hmi-${s}: ${SEVERITY_COLOR[s].light};`)
    .join('\n')
  const dark = (Object.keys(SEVERITY_COLOR) as Severity[])
    .map((s) => `  --hmi-${s}: ${SEVERITY_COLOR[s].dark};`)
    .join('\n')

  return `:root {
${light}
  --hmi-surface: hsl(220 14% 96%);
  --hmi-surface-sunken: hsl(220 13% 91%);
  --hmi-outline: hsl(215 16% 47% / 0.35);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${dark}
    --hmi-surface: hsl(222 16% 14%);
    --hmi-surface-sunken: hsl(222 18% 11%);
    --hmi-outline: hsl(215 14% 62% / 0.35);
  }
}
:root[data-theme="dark"] {
${dark}
  --hmi-surface: hsl(222 16% 14%);
  --hmi-surface-sunken: hsl(222 18% 11%);
  --hmi-outline: hsl(215 14% 62% / 0.35);
}`
}

/**
 * Uprawnienia warstwy bezpieczeństwa.
 *
 * `approve` jest tu najcięższym uprawnieniem: to podpis pod dokumentem, który
 * w postępowaniu przed organem nadzoru jest dowodem należytej staranności
 * albo dowodem jej braku. Zgłaszanie incydentów jest najlżejsze i celowo
 * nadane szeroko - niezgłoszony incydent jest gorszy niż każdy zgłoszony.
 */
export const features = [
  { id: 'safety.view', title: 'Podgląd uzasadnień i ewaluacji', module: 'safety' },
  { id: 'safety.author', title: 'Redagowanie uzasadnień bezpieczeństwa', module: 'safety' },
  { id: 'safety.approve', title: 'Zatwierdzanie uzasadnień bezpieczeństwa', module: 'safety' },
  { id: 'safety.evaluate', title: 'Zapisywanie przebiegów ewaluacyjnych', module: 'safety' },
  { id: 'safety.incidents.report', title: 'Zgłaszanie incydentów', module: 'safety' },
]

export default features

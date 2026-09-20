/**
 * Uprawnienia księgi epizodów.
 *
 * `intervene` jest nadane szeroko i celowo: zgłoszenie, że człowiek przerwał
 * pracę maszyny, ma być tanie. Uprawnienie, o które trzeba prosić, kończy się
 * niezgłaszanymi interwencjami, a niezgłoszona interwencja jest gorsza niż
 * żadna - psuje jedyną liczbę, która mówi, czy wdrożenie idzie do przodu.
 */
export const features = [
  { id: 'episodes.view', title: 'Podgląd epizodów i kadencji', module: 'episodes' },
  { id: 'episodes.record', title: 'Zapisywanie epizodów', module: 'episodes' },
  { id: 'episodes.intervene', title: 'Zgłaszanie interwencji', module: 'episodes' },
  { id: 'episodes.reconcile', title: 'Przeliczanie liczników księgi', module: 'episodes' },
]

export default features

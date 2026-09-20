/**
 * Uprawnienia wdrożeń etapowych.
 *
 * Nie ma tu uprawnienia „pomiń bramę" i nie będzie. Człowiek może zatrzymać
 * wdrożenie w każdej chwili (`rollout.halt`), ale nie może go przepchnąć obok
 * liczb - bo to jedyne, co odróżnia wdrożenie etapowe od wdrożenia na raz
 * z dodatkowym spotkaniem.
 */
export const features = [
  { id: 'rollout.view', title: 'Podgląd wdrożeń etapowych', module: 'rollout' },
  { id: 'rollout.plan', title: 'Planowanie wdrożenia', module: 'rollout' },
  { id: 'rollout.start', title: 'Uruchamianie etapu', module: 'rollout' },
  { id: 'rollout.halt', title: 'Zatrzymywanie wdrożenia', module: 'rollout' },
]

export default features

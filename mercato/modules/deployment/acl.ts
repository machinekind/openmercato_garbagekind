/**
 * Uprawnienia kanału stanu pożądanego.
 *
 * `assign` jest tu najcięższym uprawnieniem w całym systemie: to ono sprawia,
 * że wyuczony sterownik zaczyna ruszać ramieniem. Odwołanie (`revoke`) jest
 * celowo lżejsze i nadane szerzej - zatrzymanie ma być tanie, bo inaczej
 * ludzie przestają go używać.
 */
export const features = [
  { id: 'deployment.view', title: 'Podgląd wdrożeń', module: 'deployment' },
  { id: 'deployment.assign', title: 'Przypisywanie polityki do robota', module: 'deployment' },
  { id: 'deployment.revoke', title: 'Odwoływanie przypisania', module: 'deployment' },
]

export default features

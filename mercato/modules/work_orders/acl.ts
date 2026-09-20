/**
 * Uprawnienia mostu.
 *
 * `work_orders.weigh` jest osobne od `work_orders.manage` i to jest tu
 * najważniejszy podział: wpisanie masy z wagi tworzy zapas magazynowy
 * i jednocześnie wystawia ocenę maszynie. Kto może zważyć pojemnik,
 * ten może jednym wpisem dodać towar do stanu - to nie jest uprawnienie
 * do rozdawania razem z podglądem.
 */
export const features = [
  { id: 'work_orders.view', title: 'Podgląd zleceń roboczych', module: 'work_orders' },
  { id: 'work_orders.manage', title: 'Zakładanie i zamykanie zleceń', module: 'work_orders' },
  { id: 'work_orders.weigh', title: 'Zamykanie partii z wpisem masy', module: 'work_orders' },
]

/**
 * Rejestr modułów sięga po `default`, tak samo jak przy `setup.ts`.
 * Sam nazwany eksport przechodzi bez błędu i bez skutku.
 */
export default features

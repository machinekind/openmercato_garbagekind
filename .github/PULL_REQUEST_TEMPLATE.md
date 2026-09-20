## Co zmienia

<!-- Jedno-dwa zdania o zachowaniu systemu, nie o plikach. -->

## Dlaczego tak, a nie inaczej

<!-- Jeśli odrzuciłeś kuszącą alternatywę, napisz którą i dlaczego.
     To jest część, której nie da się odtworzyć z diffa. -->

## Jak to sprawdzono

- [ ] `./mercato/install.sh`
- [ ] `yarn typecheck` w `apps/mercato`
- [ ] `yarn test` w `apps/mercato`
- [ ] `python3 -m unittest discover -s tests -p 'test_*.py'`
- [ ] sprawdzone na uruchomionej instancji (opisz co i z jakim wynikiem)

## Wpływ na warstwę fizyczną

<!-- Wypełnij, jeśli zmiana dotyka fleet, edge, deployment, safety,
     policy_registry lub mercato/hardware. W przeciwnym razie wpisz „brak". -->

- Czy zmienia warunki dopuszczenia maszyny do pracy?
- Czy zmienia kontrakt kanału brzegowego (przedrostki podpisów, sekwencje)?
- Czy wymaga migracji bazy?

## Czego ta zmiana nie robi

<!-- Granice wprost. Lepiej napisać „nie obejmuje X", niż pozwolić komuś
     założyć, że obejmuje. -->

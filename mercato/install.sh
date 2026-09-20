#!/usr/bin/env bash
# Wstrzykuje moduly tego repozytorium do klonu Open Mercato i wlacza je
# w apps/mercato.
#
# Turbopack nie rozwiazuje symlinkow poza katalogiem projektu, wiec moduly sa
# KOPIOWANE. Zrodlem prawdy zostaje to repozytorium; po kazdej zmianie uruchom
# skrypt ponownie i przegeneruj artefakty (yarn generate).
#
# Uzycie:
#   ./mercato/install.sh            # wszystkie moduly z mercato/modules
#   ./mercato/install.sh fleet      # wybrane
#
# Klon Open Mercato wskazuje zmienna MERCATO_ROOT. Bez niej skrypt szuka
# w typowych miejscach obok tego repozytorium — absolutna sciezka z jednej
# stacji roboczej nie ma prawa byc wartoscia domyslna w repozytorium.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

if [ -z "${MERCATO_ROOT:-}" ]; then
  for kandydat in \
    "$REPO/open-mercato" \
    "$REPO/../open-mercato" \
    "$REPO/../open-mercato/open-mercato" \
    "$HOME/open-mercato" \
    "$HOME/open-mercato/open-mercato"
  do
    if [ -d "$kandydat/apps/mercato" ]; then
      MERCATO_ROOT="$(cd "$kandydat" && pwd)"
      break
    fi
  done
fi

if [ -z "${MERCATO_ROOT:-}" ] || [ ! -d "$MERCATO_ROOT/apps/mercato" ]; then
  echo "Nie znaleziono klonu Open Mercato." >&2
  echo "Wskaz go zmienna, np.:  MERCATO_ROOT=~/open-mercato $0" >&2
  exit 1
fi

echo "Klon Open Mercato: $MERCATO_ROOT"

if [ "$#" -gt 0 ]; then
  MODULES=("$@")
else
  MODULES=()
  for dir in "$HERE"/modules/*/; do
    MODULES+=("$(basename "$dir")")
  done
fi

for module in "${MODULES[@]}"; do
  SRC="$HERE/modules/$module"
  [ -d "$SRC" ] || { echo "Brak modulu: $SRC" >&2; exit 1; }
  TARGET="$MERCATO_ROOT/apps/mercato/src/modules/$module"
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$SRC/." "$TARGET/"
  echo "Skopiowano $module -> $TARGET"

  python3 - "$MERCATO_ROOT" "$module" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'apps' / 'mercato'
name = sys.argv[2]
modules = root / 'src' / 'modules.ts'
text = modules.read_text(encoding='utf-8')
entry = "{ id: '%s', from: '@app' }" % name
if entry not in text:
    anchor = "  { id: 'ratelimit_probe', from: '@app' },"
    text = text.replace(anchor, anchor + "\n  %s," % entry, 1)
    modules.write_text(text, encoding='utf-8')
    print('  wlaczono %s w modules.ts' % name)
else:
    print('  %s juz wlaczony' % name)
PY
done

echo "Teraz: (cd $MERCATO_ROOT/apps/mercato && yarn generate) i restart dev servera."

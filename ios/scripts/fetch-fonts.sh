#!/usr/bin/env bash
# Regenerate ios/CCRemote/Resources/Fonts/ — the three voices of the design
# system, as files CoreText can actually register.
#
# The fonts are CHECKED IN on purpose (same reasoning as deploy/fetch-fonts.sh:
# the build must not depend on a third party being up). Run this only when a
# voice or a weight changes, then commit what it writes.
#
# Four things differ from the web's deploy/fetch-fonts.sh, and each one is a bug
# we would otherwise ship:
#
#   1. TTF/OTF, not woff2. CoreText does not register a woff2 at all, so
#      `Font.custom` would silently fall back to SF and nothing would look wrong
#      until someone compared screenshots.
#   2. STATIC instances, not variable. `Font.custom` has no API for variation
#      axes, so `.weight(.semibold)` on a variable face is a no-op — every
#      weight renders at the default. Onest upstream ships ONLY a variable
#      `Onest[wght].ttf`, so the four weights are instanced here with
#      fontTools; IBM Plex and Source Serif ship real statics, which we take.
#   3. FULL character sets, not the web's subsets. web/src/fonts/ holds
#      latin+cyrillic woff2 subsets built for the browser; the interface is
#      Russian, and a subset that drops a glyph shows tofu on a phone.
#   4. Pinned + checksummed. Upstream moves; a silent re-cut of a typeface
#      would change every screenshot in the repo with no diff to explain it.
#
# The fonts are referenced from Info.plist via UIAppFonts (see ios/project.yml).
# The bundle copies them because the whole `CCRemote` directory is a source
# path, so new files here need no project.yml edit — only a UIAppFonts entry.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="CCRemote/Resources/Fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Reproducible output: fontTools stamps head.modified from the clock unless
# SOURCE_DATE_EPOCH pins it, which would make every run produce a different
# binary and a spurious diff.
export SOURCE_DATE_EPOCH=1700000000

# --- pinned sources -------------------------------------------------------
# Onest has no upstream static build (simpals/onest ships sources + a variable
# binary only), so we take Google Fonts' variable cut at a pinned commit and
# instance it below.
GF_COMMIT="4c1db3aec83c67dd223dd82a68c039cab30917a9"
ONEST_URL="https://raw.githubusercontent.com/google/fonts/$GF_COMMIT/ofl/onest/Onest%5Bwght%5D.ttf"
ONEST_SHA="966c5c29b4755da84b6854d5c21dd4eaa2420225d0e9874de602de176d4a9f31"
ONEST_OFL_URL="https://raw.githubusercontent.com/google/fonts/$GF_COMMIT/ofl/onest/OFL.txt"

# IBM ships per-family releases now; @ibm/plex-mono@2.5.0 is the last one with
# `fonts/complete/ttf` (complete = the full charset, including Cyrillic).
PLEX_URL="https://github.com/IBM/plex/releases/download/@ibm/plex-mono@2.5.0/ibm-plex-mono.zip"
PLEX_SHA="6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c"

# Adobe's desktop zip carries the static OTFs. We take the text optical size
# (SourceSerif4-*), not Display/Caption/Subhead.
SERIF_URL="https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip"
SERIF_SHA="549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425"

fetch() { # url dest sha256
  echo "  fetch $(basename "$2")"
  curl -sSfL -o "$2" "$1"
  local got
  got=$(shasum -a 256 "$2" | cut -d' ' -f1)
  if [ "$got" != "$3" ]; then
    echo "ERROR: checksum mismatch for $1" >&2
    echo "  expected $3" >&2
    echo "  got      $got" >&2
    exit 1
  fi
}

rm -rf "$DEST"
mkdir -p "$DEST"

echo "[fonts] Onest (variable -> 4 static instances)"
fetch "$ONEST_URL" "$WORK/Onest-var.ttf" "$ONEST_SHA"
# --update-name-table rewrites name IDs 1/2/4/6/16/17 for the instance, so the
# file reports itself as e.g. "Onest SemiBold" / PostScript "Onest-SemiBold"
# instead of inheriting the variable font's "Onest Regular".
for pair in "400:Regular" "500:Medium" "600:SemiBold" "700:Bold"; do
  wght="${pair%%:*}"; style="${pair##*:}"
  python3 -m fontTools.varLib.instancer "$WORK/Onest-var.ttf" \
    "wght=$wght" --update-name-table -o "$DEST/Onest-$style.ttf" >/dev/null
  echo "  Onest-$style.ttf (wght=$wght)"
done
curl -sSfL -o "$DEST/OFL-Onest.txt" "$ONEST_OFL_URL"

echo "[fonts] IBM Plex Mono (static)"
fetch "$PLEX_URL" "$WORK/plex.zip" "$PLEX_SHA"
for style in Regular Medium SemiBold; do
  unzip -o -j "$WORK/plex.zip" \
    "ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-$style.ttf" -d "$DEST" >/dev/null
  echo "  IBMPlexMono-$style.ttf"
done
unzip -o -j "$WORK/plex.zip" "ibm-plex-mono/LICENSE.txt" -d "$WORK" >/dev/null
mv "$WORK/LICENSE.txt" "$DEST/OFL-IBMPlexMono.txt"

echo "[fonts] Source Serif 4 (static, text optical size)"
fetch "$SERIF_URL" "$WORK/serif.zip" "$SERIF_SHA"
for f in SourceSerif4-Regular.otf SourceSerif4-It.otf; do
  unzip -o -j "$WORK/serif.zip" "source-serif-4.005_Desktop/OTF/$f" -d "$DEST" >/dev/null
  echo "  $f"
done
unzip -o -j "$WORK/serif.zip" "source-serif-4.005_Desktop/LICENSE.md" -d "$WORK" >/dev/null
mv "$WORK/LICENSE.md" "$DEST/OFL-SourceSerif4.txt"

# --- verify ---------------------------------------------------------------
# The three things that silently break a bundled font: it is still variable
# (weights collapse), it lost Cyrillic (tofu in a Russian UI), or its
# PostScript name is not what the call site passes to Font.custom. Print all
# three so a bad cut is visible here rather than on a screenshot.
echo
echo "[fonts] verification — PostScript name is what Font.custom() must be given:"
python3 - "$DEST" <<'PY'
import sys, glob, os
from fontTools.ttLib import TTFont
bad = False
rows = []
for p in sorted(glob.glob(os.path.join(sys.argv[1], '*.[to]tf'))):
    f = TTFont(p, lazy=True)
    n = f['name']
    cmap = f.getBestCmap()
    cyr = all(c in cmap for c in (0x0410, 0x042F, 0x0430, 0x044F, 0x0401, 0x0451))
    var = 'fvar' in f
    rows.append((os.path.basename(p), n.getDebugName(6), n.getDebugName(16) or n.getDebugName(1),
                 f['OS/2'].usWeightClass, 'yes' if cyr else 'NO', 'YES' if var else 'no',
                 round(os.path.getsize(p) / 1024)))
    if var or not cyr:
        bad = True
w = [max(len(str(r[i])) for r in rows + [('file', 'postscript', 'family', 'wght', 'cyr', 'var', 'KB')]) for i in range(7)]
hdr = ('file', 'postscript', 'family', 'wght', 'cyr', 'var', 'KB')
print('  ' + '  '.join(str(h).ljust(w[i]) for i, h in enumerate(hdr)))
print('  ' + '  '.join('-' * w[i] for i in range(7)))
for r in rows:
    print('  ' + '  '.join(str(c).ljust(w[i]) for i, c in enumerate(r)))
total = sum(r[6] for r in rows)
print(f"\n  {len(rows)} faces, {total} KB")
if bad:
    print("\nERROR: a face is still variable or is missing Cyrillic", file=sys.stderr)
    sys.exit(1)
PY

echo
echo "[fonts] done -> $DEST"
echo "If a filename changed, update UIAppFonts in ios/project.yml and rerun xcodegen."

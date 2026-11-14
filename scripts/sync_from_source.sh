#!/usr/bin/env bash
# Re-runnable sync from the working folder (SRC) into this repo.
# Whitelist only: anything not listed here is never copied. Edits (sed) are applied to
# the copy in this repo only; the source folder is never touched.
# Usage: scripts/sync_from_source.sh [SRC]   (default SRC: ../Oceany next to this repo)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$REPO/../Oceany}"
SRC="$(cd "$SRC" && pwd)"
V=pieces/01-seafloor/viewer
echo "sync $SRC -> $REPO"

RS=(rsync -a --prune-empty-dirs --exclude='.DS_Store' --exclude='__pycache__' --exclude='*.pyc')

# --- viewer: code, vendor, and only the data files the viewer code references -------------
mkdir -p "$REPO/$V/data"
for f in index.html main.js style.css play.js tutorial.js TUTORIAL.md README.md; do
  [ -f "$SRC/$V/$f" ] && cp "$SRC/$V/$f" "$REPO/$V/$f"
done
"${RS[@]}" --delete "$SRC/$V/vendor/" "$REPO/$V/vendor/"
# data/: copy a file only if its name appears in the viewer code (drops unused porto_batel_slice_v2* etc.)
find "$REPO/$V/data" -type f -delete
for f in "$SRC/$V/data/"*; do
  b="$(basename "$f")"
  if grep -qF "$b" "$SRC/$V/"{index.html,main.js,play.js,tutorial.js} 2>/dev/null; then cp "$f" "$REPO/$V/data/$b"; fi
done

# --- pieces: python, small readmes and small intermediate data -----------------------------
for p in 01-seafloor 02-reefs 03-breaking-wave 05-pipeline; do
  mkdir -p "$REPO/pieces/$p"
  "${RS[@]}" --include='*.py' --exclude='*' "$SRC/pieces/$p/" "$REPO/pieces/$p/"
done
# 01: small derived data (json, nc); raw/ stays out
mkdir -p "$REPO/pieces/01-seafloor/data"
"${RS[@]}" --include='*.json' --include='*.nc' --exclude='*' "$SRC/pieces/01-seafloor/data/" "$REPO/pieces/01-seafloor/data/"
# 02: surf zones and the Open-Meteo snapshots; raw/ stays out
mkdir -p "$REPO/pieces/02-reefs/data"
"${RS[@]}" --include='surf_zones.json' --include='swell_snapshot_*' --exclude='*' "$SRC/pieces/02-reefs/data/" "$REPO/pieces/02-reefs/data/"
# 03: README, bed-profile data, and the energy study write-up (referenced by case_porto_batel.py)
cp "$SRC/pieces/03-breaking-wave/README.md" "$REPO/pieces/03-breaking-wave/README.md"
mkdir -p "$REPO/pieces/03-breaking-wave/data" "$REPO/pieces/03-breaking-wave/energy_s6"
"${RS[@]}" --include='*.csv' --include='*.json' --exclude='*' "$SRC/pieces/03-breaking-wave/data/" "$REPO/pieces/03-breaking-wave/data/"
cp "$SRC/pieces/03-breaking-wave/energy_s6/FINDINGS.md" "$REPO/pieces/03-breaking-wave/energy_s6/FINDINGS.md"
# RESULTS.md files are session logs that point at unshipped files, so they stay out.
# 01/02 check plots that explain the method (small pngs)
for f in pieces/02-reefs/simulate_swell.png; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$REPO/$f"; done

# --- tasks and live-data (scripts only) -----------------------------------------------------
"${RS[@]}" --delete --include='*/' --include='*.py' --include='README.md' --exclude='*' "$SRC/tasks/" "$REPO/tasks/"
mkdir -p "$REPO/live-data"
"${RS[@]}" --include='*.py' --exclude='*' "$SRC/live-data/" "$REPO/live-data/"
cp "$SRC/requirements.txt" "$REPO/requirements.txt"

# --- text fixes, repo copy only --------------------------------------------------------------
# run commands: drop the dev-environment venv path, plain python
FILES=$(find "$REPO/pieces" "$REPO/tasks" "$REPO/live-data" -type f \( -name '*.py' -o -name '*.md' -o -name '*.js' -o -name '*.html' \) -not -path '*/vendor/*')
SED() { sed -i '' -E "$@" ; }   # BSD sed
for f in $FILES; do
  SED -e 's#(\.\./)+\.venv/bin/python( -I)?#python#g' \
      -e 's#\.venv/bin/python( -I)?#python#g' \
      -e 's#cmems-venv/bin/(python|copernicusmarine)#\1#g' \
      -e 's#python apis/#python #g' \
      -e "s#Benn's (pins|sketch|marks)#observer marks#g" \
      -e "s#(the )?user's (own )?(pins|sketch)#observer marks#g" \
      -e 's#with the Oceany environment \(`\.\./\.\./\.venv`, numba added\)#with the packages in the top-level requirements.txt#' \
      "$f"
done
for f in "$REPO/$V/main.js" "$REPO/pieces/02-reefs/data/surf_zones.json"; do
  [ -f "$f" ] && SED -e "s#Benn's (pins|sketch|marks)#observer marks#g" "$f"
done
# keep sources of this script's own safety: fail if anything private slipped in
if grep -rIlE '/Users/|bennhvid|@gmail|surfline' "$REPO/pieces" "$REPO/tasks" "$REPO/live-data" "$REPO/requirements.txt" 2>/dev/null | grep -v '/vendor/' ; then
  echo "WARNING: private-looking strings found in the files above" >&2; exit 1
fi
echo "sync done. size: $(du -sh "$REPO" --exclude=.git 2>/dev/null | cut -f1)"

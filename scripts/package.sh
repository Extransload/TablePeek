#!/usr/bin/env bash
# Release archives, as the release workflow makes them (and as a maintainer
# can make them locally to try it out).
#
#   scripts/package.sh archive <tag> <target> <binary> <out-dir>
#       tablepeek-<tag>-<target>.tar.gz (or .zip for Windows targets) in
#       out-dir, holding a tablepeek-<tag>-<target>/ folder with the binary,
#       README.md and LICENSE.
#   scripts/package.sh desktop <tag> <target> <bundle-dir> <out-dir>
#       The desktop app's bundles from tauri's bundle-dir (target/<target>/
#       release/bundle) under release names in out-dir: on macOS
#       TablePeek-<tag>-<target>.dmg and the updater's .app.tar.gz with its
#       .sig, on Windows TablePeek-<tag>-<target>-setup.exe with its .sig.
#   scripts/package.sh sums <dir>
#       SHA256SUMS in dir, one line per archive, disk image and installer.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

archive() {
  local tag="$1" target="$2" binary="$3" out="$4"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "package: not a release tag: $tag" >&2; exit 1; }
  [ -f "$binary" ] || { echo "package: no binary at $binary" >&2; exit 1; }
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  local name="tablepeek-$tag-$target"
  local stage
  stage="$(mktemp -d)"
  mkdir "$stage/$name"
  case "$target" in
    *windows*) cp "$binary" "$stage/$name/tablepeek.exe" ;;
    *) cp "$binary" "$stage/$name/tablepeek" && chmod 755 "$stage/$name/tablepeek" ;;
  esac
  cp "$root/README.md" "$stage/$name/"
  for license in LICENSE LICENSE.md LICENSE.txt; do
    if [ -f "$root/$license" ]; then cp "$root/$license" "$stage/$name/"; fi
  done
  case "$target" in
    *windows*)
      rm -f "$out/$name.zip"
      if command -v 7z > /dev/null; then
        (cd "$stage" && 7z a -tzip -bd "$out/$name.zip" "$name" > /dev/null)
      else
        (cd "$stage" && zip -qr "$out/$name.zip" "$name")
      fi
      echo "$out/$name.zip"
      ;;
    *)
      # COPYFILE_DISABLE keeps macOS tar from adding ._ metadata files.
      (cd "$stage" && COPYFILE_DISABLE=1 tar -czf "$out/$name.tar.gz" "$name")
      echo "$out/$name.tar.gz"
      ;;
  esac
  rm -rf "$stage"
}

# The one file in $1 matching $2, or a failure.
only_file() {
  local matches=()
  shopt -s nullglob
  matches=("$1"/$2)
  shopt -u nullglob
  [ ${#matches[@]} -eq 1 ] || { echo "package: expected one $2 in $1, found ${#matches[@]}" >&2; exit 1; }
  echo "${matches[0]}"
}

desktop() {
  local tag="$1" target="$2" bundle="$3" out="$4"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "package: not a release tag: $tag" >&2; exit 1; }
  mkdir -p "$out"
  local name="TablePeek-$tag-$target" file
  case "$target" in
    *apple-darwin)
      file="$(only_file "$bundle/dmg" '*.dmg')"
      cp "$file" "$out/$name.dmg"
      file="$(only_file "$bundle/macos" '*.app.tar.gz')"
      cp "$file" "$out/$name.app.tar.gz"
      cp "$file.sig" "$out/$name.app.tar.gz.sig"
      ;;
    *windows*)
      file="$(only_file "$bundle/nsis" '*-setup.exe')"
      cp "$file" "$out/$name-setup.exe"
      cp "$file.sig" "$out/$name-setup.exe.sig"
      ;;
    *) echo "package: no desktop app for $target" >&2; exit 1 ;;
  esac
  ls "$out"/"$name"*
}

sums() {
  local dir="$1"
  (
    cd "$dir"
    shopt -s nullglob
    local files=(tablepeek-v*.tar.gz tablepeek-v*.zip TablePeek-v*.dmg TablePeek-v*.app.tar.gz TablePeek-v*-setup.exe)
    [ ${#files[@]} -gt 0 ] || { echo "package: no archives in $dir" >&2; exit 1; }
    if command -v sha256sum > /dev/null; then
      sha256sum "${files[@]}" > SHA256SUMS
    else
      shasum -a 256 "${files[@]}" > SHA256SUMS
    fi
    cat SHA256SUMS
  )
}

case "${1:-}" in
  archive) [ $# -eq 5 ] || { echo "usage: package.sh archive <tag> <target> <binary> <out-dir>" >&2; exit 2; }; archive "$2" "$3" "$4" "$5" ;;
  desktop) [ $# -eq 5 ] || { echo "usage: package.sh desktop <tag> <target> <bundle-dir> <out-dir>" >&2; exit 2; }; desktop "$2" "$3" "$4" "$5" ;;
  sums) [ $# -eq 2 ] || { echo "usage: package.sh sums <dir>" >&2; exit 2; }; sums "$2" ;;
  *) echo "usage: package.sh archive <tag> <target> <binary> <out-dir> | desktop <tag> <target> <bundle-dir> <out-dir> | sums <dir>" >&2; exit 2 ;;
esac

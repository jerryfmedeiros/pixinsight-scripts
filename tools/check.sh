#!/bin/sh
#
# Syntax-checks every script the way PixInsight will read it.
#
# The PJSR preprocessor treats a double slash as the start of a comment
# anywhere on a line, including inside strings and regular expressions, so
# code that is valid JavaScript can still break in PixInsight. This strips
# those "comments" and the preprocessor directives, then runs node --check.
#
# Usage: tools/check.sh [file ...]    (default: all .js and .jsh files)

cd "$(dirname "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
   echo "node is required" >&2
   exit 1
fi

[ $# -eq 0 ] && set -- $(find . \( -name '*.js' -o -name '*.jsh' \) -not -path './tools/*' -not -path './.git/*')

tmpdir=$(mktemp -d) || exit 1
trap 'rm -rf "$tmpdir"' EXIT
tmp="$tmpdir/script.js"

status=0
for f in "$@"; do
   # Double slash after an opening quote: fine in JavaScript, cut short in PJSR.
   if grep -n "[\"'].*//" "$f" | grep -v '^[0-9]*:[[:space:]]*//' >/dev/null; then
      echo "$f: double slash inside a string or regex (PJSR treats it as a comment):"
      grep -n "[\"'].*//" "$f" | grep -v '^[0-9]*:[[:space:]]*//'
      status=1
   fi
   sed -e 's#//.*$##' -e 's/^#.*//' "$f" > "$tmp"
   if node --check "$tmp" 2>/dev/null; then
      echo "ok   $f"
   else
      echo "FAIL $f"
      node --check "$tmp" 2>&1 | sed -n '2,5p'
      status=1
   fi
done
exit $status

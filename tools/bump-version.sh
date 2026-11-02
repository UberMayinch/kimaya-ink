#!/bin/sh
# bump the cache-busting ?v= of the hero (journey.js + experience/*.js) and style.css in one go.
# usage: tools/bump-version.sh 26
set -e
n="$1"
[ -n "$n" ] || { echo "usage: tools/bump-version.sh <number>" >&2; exit 1; }
cd "$(dirname "$0")/.."
sed -i -E "s#(journey\.js\?v=)[0-9]+#\1$n#; s#(style\.css\?v=)[0-9]+#\1$n#" index.html
sed -i -E "s#(style\.css\?v=)[0-9]+#\1$n#" admin.html
sed -i -E "s#((experience/|\./)[a-z-]+\.js\?v=)[0-9]+#\1$n#g" journey.js experience/*.js
echo "journey.js, experience/*.js and style.css now at ?v=$n"

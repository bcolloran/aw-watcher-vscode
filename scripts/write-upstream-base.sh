#!/usr/bin/env bash
# Records the upstream commit this build is based on, in out/upstream-base.json, for the extension's daily upstream check.
#
# The base is the merge base of HEAD and upstream/master, so merging upstream moves it forward with no manual bookkeeping.
# Needs a remote named "upstream" pointing at https://github.com/ActivityWatch/aw-watcher-vscode.git.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "ERROR: no 'upstream' remote. Add it with:" >&2
    echo "  git remote add upstream https://github.com/ActivityWatch/aw-watcher-vscode.git" >&2
    exit 1
fi

# Refresh upstream/master so the recorded base reflects what has actually been merged
git fetch --quiet upstream master

base="$(git merge-base HEAD upstream/master)"

mkdir -p out
printf '{"upstreamBase": "%s"}\n' "$base" > out/upstream-base.json
echo "Recorded upstream base $base in out/upstream-base.json"

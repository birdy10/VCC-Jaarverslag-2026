#!/usr/bin/env bash
# Stop hook: commit whatever changed in this turn. Local commit only; pushing (= deploying) stays manual.
cd "$(dirname "$0")/.." || exit 0
git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ] && exit 0
git add -A
files=$(git diff --cached --name-only | head -5 | tr '\n' ' ')
n=$(git diff --cached --name-only | wc -l)
[ "$n" -gt 5 ] && files="$files(+$((n-5)) more)"
git commit -q -m "Auto-commit: ${files% }" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "{\"systemMessage\": \"Auto-committed: ${files% }\"}"

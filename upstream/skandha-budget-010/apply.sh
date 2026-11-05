#!/usr/bin/env bash
# Recreate the BUDGET-010 branch: clone the upstream sidecar at the pinned base commit into ./sidecar and apply
# patches/*.patch with `git am` (keeps authorship and messages, so the branch can be pushed as the PR as is).
#   ./apply.sh            # idempotent: reuses ./sidecar if the branch already exists
#   FRESH=1 ./apply.sh    # delete ./sidecar first
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source <(grep -E '^(origin|base|branch)=' UPSTREAM)
[ "${FRESH:-0}" = "1" ] && rm -rf sidecar
if [ ! -d sidecar/.git ]; then
  git clone --quiet "$origin" sidecar
fi
cd sidecar
if git rev-parse --verify --quiet "$branch" >/dev/null; then
  echo "branch $branch already exists in $(pwd); FRESH=1 to rebuild it"
else
  git fetch --quiet origin "$base" 2>/dev/null || true
  git checkout --quiet -b "$branch" "$base"
  git -c user.name="${GIT_AUTHOR_NAME:-patch-apply}" -c user.email="${GIT_AUTHOR_EMAIL:-patch-apply@localhost}" \
    am --quiet --committer-date-is-author-date ../patches/*.patch
fi
git checkout --quiet "$branch"
echo "sidecar @ $(git rev-parse --short HEAD) on $branch ($(git rev-list --count "$base"..HEAD) patches over ${base:0:8})"

#!/bin/sh
# push current main tree to the public repos as a single squashed commit
# usage: scripts/sync-public.sh [optional note]
set -e

cd "$(git rev-parse --show-toplevel)"
msg="sync $(git rev-parse --short HEAD)${1:+: $1}"
tree=$(git rev-parse main^{tree})

if git rev-parse -q --verify public-release >/dev/null 2>&1; then
  parent=$(git rev-parse public-release)
  commit=$(git commit-tree "$tree" -p "$parent" -m "$msg")
else
  commit=$(git commit-tree "$tree" -m "initial release")
fi
git update-ref refs/heads/public-release "$commit"

for remote in github-public gitlab-public; do
  if ! git config remote."$remote".url >/dev/null 2>&1; then
    echo "skipping $remote (not configured)"
    continue
  fi
  echo "pushing to $remote..."
  git push "$remote" public-release:main
done

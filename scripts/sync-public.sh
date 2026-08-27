#!/bin/sh
# push current main tree to the public repos as a single squashed commit
# usage: scripts/sync-public.sh [optional note]
set -e

cd "$(git rev-parse --show-toplevel)"
msg="sync $(git rev-parse --short HEAD)${1:+: $1}"

# inject the live commit count into the mirrored README
count=$(git rev-list --count main)
tmp=$(mktemp)
git show main:README.md | sed -E "s/\*\*<!--COMMIT_COUNT:[^>]*-->\*\*/**${count}**/g" > "$tmp"
readme_blob=$(git hash-object -w "$tmp")
rm -f "$tmp"

# build a tree identical to main but with the updated README
git read-tree main
git update-index --cacheinfo 100644 "$readme_blob" README.md
tree=$(git write-tree)

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
  git push --force "$remote" public-release:main
done

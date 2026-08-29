#!/bin/sh
# push current main tree to the public repos as a single squashed commit
# also pulls any commits made on the public mirrors back into private main
# usage: scripts/sync-public.sh [optional note]
set -e

cd "$(git rev-parse --show-toplevel)"

# --- reverse sync: bring public mirror commits into private main ---
reverse_sync() {
  remote="$1"
  if ! git config remote."$remote".url >/dev/null 2>&1; then
    echo "skipping reverse-sync from $remote (not configured)"
    return 0
  fi
  echo "reverse-syncing from $remote..."
  git fetch -q "$remote" "main:refs/remotes/$remote/main" || return 0
  # commits on the public mirror not present in private main
  for c in $(git rev-list --reverse "$remote/main" ^main); do
    if ! git cherry-pick -n "$c" 2>/dev/null; then
      git cherry-pick --abort 2>/dev/null || true
      echo "skip unmergeable commit $c from $remote"
      continue
    fi
    # keep our README (placeholder) — mirror README is regenerated
    if git diff --cached --name-only | grep -qx README.md; then
      git checkout HEAD -- README.md 2>/dev/null || true
      git restore --staged -- README.md 2>/dev/null || true
    fi
    # nothing but README changed (or README-only commit): skip
    if [ -z "$(git diff --cached --name-only)" ]; then
      git cherry-pick --abort 2>/dev/null || true
      continue
    fi
    git commit -C "$c" >/dev/null 2>&1 || git commit --allow-empty -C "$c"
    echo "merged $c from $remote into main"
  done
}

reverse_sync github-public
reverse_sync gitlab-public

# --- forward sync: build snapshot tree from private main ---
msg="sync $(git rev-parse --short HEAD)${1:+: $1}"

count=$(git rev-list --count main)
tmp=$(mktemp)
git show main:README.md | sed -E "s/\*\*<!--COMMIT_COUNT:[^>]*-->\*\*/**${count}**/g" > "$tmp"
readme_blob=$(git hash-object -w "$tmp")
rm -f "$tmp"

git read-tree main
# drop private-only files from the public snapshot
git rm --cached -q AGENTS.md 2>/dev/null || true
git rm --cached -q .github/dependabot.yml 2>/dev/null || true
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

# back up private history
if git config remote.github.url >/dev/null 2>&1; then
  echo "backing up private history to github (litter-private)..."
  git push github main
fi

echo "done. public mirrors show $count commits."

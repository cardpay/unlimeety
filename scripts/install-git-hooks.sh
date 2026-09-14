#!/bin/sh
set -eu

if ! repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    printf '%s\n' 'Personal-data guard: not inside a Git worktree.' >&2
    exit 1
fi

if [ ! -x "$repo_root/.githooks/pre-commit" ] || [ ! -x "$repo_root/.githooks/commit-msg" ]; then
    printf '%s\n' 'Personal-data guard: tracked hook entry points are missing or not executable.' >&2
    exit 1
fi

existing=$(git config --local --get core.hooksPath || true)
if [ -n "$existing" ] && [ "$existing" != ".githooks" ]; then
    printf '%s\n' 'Personal-data guard: existing core.hooksPath is not .githooks; refusing to replace it.' >&2
    exit 1
fi

git config --local core.hooksPath .githooks
printf '%s\n' 'Personal-data guard: configured core.hooksPath=.githooks'

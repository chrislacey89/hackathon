#!/bin/bash
# Quality gate — runs after each Write/Edit to catch issues early.
# Biome-only by design: chosen at install time over the full
# biome + tsc + vitest loop, which is too slow for this project's
# hard 8-hour appetite. tsc and vitest run at pre-commit / on demand.

# Anchor to the project root before running any feedback loop. If the
# directory is gone — e.g. a worktree was removed out from under the
# shell during /closeout teardown — no-op instead of emitting false
# MODULE_NOT_FOUND errors from a vanished node_modules. A stranded cwd
# must never masquerade as a lint failure.
if [ -z "$CLAUDE_PROJECT_DIR" ] || [ ! -d "$CLAUDE_PROJECT_DIR" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR" || exit 0

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only gate TypeScript/JavaScript implementation files
if [[ ! "$FILE_PATH" == *.ts && ! "$FILE_PATH" == *.tsx && ! "$FILE_PATH" == *.js && ! "$FILE_PATH" == *.jsx ]]; then
  exit 0
fi
# Skip test files, type declarations, config files
if [[ "$FILE_PATH" == *test* || "$FILE_PATH" == *spec* || "$FILE_PATH" == *.d.ts || "$FILE_PATH" == *.config.* ]]; then
  exit 0
fi

# No-op until dependencies are installed (pre-scaffold, or a fresh clone).
if [ ! -x node_modules/.bin/biome ]; then
  exit 0
fi

# Check the single edited file rather than the whole tree — keeps the
# post-edit loop sub-second and scopes feedback to what just changed.
BIOME_OUTPUT=$(node_modules/.bin/biome check --no-errors-on-unmatched --files-ignore-unknown=true --colors=off "$FILE_PATH" 2>&1)
if [ $? -ne 0 ]; then
  echo "Biome errors found:" >&2
  echo "$BIOME_OUTPUT" >&2
  exit 2
fi

exit 0

#!/bin/bash
# TDD classification gate.
# Blocks Write/Edit of implementation files until /execute Step 3 classification
# has been passed — either .claude/.tdd-active (TDD invoked) or
# .claude/.tdd-skipped (visual frontend, explicitly opted out).
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Implementation patterns — narrowed to TS/JS at install time (confirmed with the
# user). This project is TypeScript/Node end-to-end: Next.js app + pipeline.
IMPL_PATTERNS=("*.ts" "*.tsx" "*.js" "*.jsx")

MATCHED=0
for pattern in "${IMPL_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == $pattern ]]; then MATCHED=1; break; fi
done
if [ $MATCHED -eq 0 ]; then exit 0; fi

# Skip test files and type declarations (extension-agnostic)
if [[ "$FILE_PATH" == *test* || "$FILE_PATH" == *spec* || "$FILE_PATH" == *.d.ts ]]; then
  exit 0
fi
# Skip config files (next.config, vitest.config, etc.)
if [[ "$FILE_PATH" == *.config.* ]]; then
  exit 0
fi
# Check for classification markers
if [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-active" ] && [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-skipped" ]; then
  echo '{"decision":"block","reason":"BLOCKED: classify work in /execute Step 3 before writing implementation files. Either invoke /tdd (backend/behavior-heavy) or create .claude/.tdd-skipped (visual frontend)."}' >&2
  exit 2
fi
exit 0

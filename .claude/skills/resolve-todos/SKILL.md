---
name: resolve-todos
description: Find every TODO(claude) comment in the codebase and resolve each one, optimized for a fast hand-back, since the code is usually mid-refactor and may not compile or pass tests. Use when the user says things like "resolve the TODO(claude)s", "do the claude todos", "clear my claude markers", or invokes /resolve-todos.
trigger: When the user asks to resolve, do, action, or clear "TODO(claude)" comments in the codebase.
---

# Resolve TODO(claude)

The user leaves `TODO(claude)` markers in the code as inline prompts -- a place where he wants Claude
to pick up the work. This skill finds them all and resolves each one. **The text of the TODO is the
instruction.** Treat each marker as if the user had pasted that comment to you as a prompt.

## Procedure

1. Scan: `git grep --line-number --fixed-strings --untracked "TODO(claude)" -- . ':(exclude).claude/skills/resolve-todos/SKILL.md'`
2. Read each file returned and any relevant tests/ or docs/ to get a complete picture of what you need to do. Typically all the TODOs will be part of a larger refactor, take time to understand the intent and what the ask is.
3. Ask the user any questions you have. Don't assume. If a TODO is ambiguous, has multiple reasonable interpretations, or hides a design decision, ask the user *before* writing code.
4. Implement the TODOs. Don't edit any docs or tests unless the user asks you to. If in doubt about the scope, especially if you'd like to edit files beyond the TODO, ask the user.
5. In general, don't run tests, typechecks, lint, or formatting. This is typically called as part of a larger refactor by the user so the intent should be to return control back to the user as quickly as possible so they can keep iterating. Quality should still be prioritized over speed, as buggy work or misunderstood assumptions will require another iteration, so take the time you need to make sure it's done right, but assume the user will ask you for any validation they want done.
6. Inform the user of what you did, anything unexpected that surfaced, and any recommendations of next steps you have.

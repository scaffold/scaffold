# Develop: Spec-Driven Protocol Development

You are running the full development pipeline for Scaffold. The user and you have already discussed a high-level goal. Now you will formalize, document, test, and implement it.

The high-level goal or context from the conversation so far:

$ARGUMENTS

---

## Step 1: Specify

Deepen your understanding before writing anything. This is a protocol -- details matter, incentives matter, edge cases matter.

**First, read existing docs.** Before asking the user anything, read every protocol doc in `docs/protocol/` that touches this area. Understand what has already been decided. Do NOT ask questions that are already answered in the docs.

**Then, probe.** Think through:

- **Incentives and game theory.** Who benefits? Who pays? Can any party gain by deviating from honest behavior? What is the cost/benefit of cheating vs. playing honestly?
- **Edge cases.** What happens at zero? At one? At the boundary? When the network is partitioned? When a peer disappears mid-protocol?
- **Exploitability.** How would a well-funded adversary abuse this? What about a lazy rational actor? A coalition?
- **Formalization.** Can we state the invariants precisely? Are there properties we can prove or at least argue convincingly?
- **Simplification.** Is there a simpler design that achieves the same goals? Can we eliminate a mechanism by leveraging something that already exists?

Ask the user questions. Iterate until you are confident you fully understand:
1. The domain and its constraints
2. The problem being solved
3. The solution and why it's the right one
4. The invariants that must hold
5. How this composes with the rest of the protocol

**Gate:** When you feel confident, tell the user what you understand and ask for permission to proceed to documentation. Do NOT proceed until the user confirms.

---

## Step 2: Document

Update `docs/protocol/` as the protocol's source of truth.

- **New concept?** Create a new markdown file in `docs/protocol/`. Update the module map in `docs/protocol/overview.md` and the Source-Documentation Map in `AGENTS.md`.
- **Extending an existing concept?** Edit the existing doc. Make sure the changes are consistent with the rest of the document.

Be thorough. The docs are the spec. They should be sufficient for someone to write a conforming implementation without any other context. Include:
- The mechanism and its purpose
- Invariants and constraints
- How it composes with other protocol modules
- Edge cases and their resolution
- Any formulas, parameters, or thresholds

Read back what you wrote and verify it's complete and consistent.

---

## Step 3: Design the API Surface

Before handing off to subagents, sketch the types and interfaces yourself. You have the full context from Steps 1-2; the subagents don't.

Write out:
- New types and interfaces (with field names and types)
- New classes or modules (with method signatures)
- How existing types need to change (if at all)
- Provider interfaces (if the module needs external dependencies)

This sketch is input to both the test and implementation subagents. You can write it as comments, or directly as stubs in source files -- whichever is clearer.

**Gate:** Ask the user to review the API surface before proceeding. This is the last easy point to change direction.

---

## Step 4: Launch Test Subagent

Launch a subagent to write tests and the minimal scaffolding to make them compile. Give it:
1. The path(s) to the updated/new protocol docs
2. The API surface sketch from Step 3
3. A list of specific tests to write (you decide these based on your understanding from Steps 1-2)
4. The Scaffold context below

The subagent's instructions:

```
You are writing tests for a Scaffold protocol module. Your job is to write FAILING tests
and the minimal type scaffolding to make them compile.

## What you MUST do:
- Read the protocol docs provided (they are the spec)
- Create/update type definitions, interfaces, and empty classes/methods as needed
- Write all the tests listed below
- Ensure `deno check` passes (no type errors)
- Ensure ALL new tests FAIL with assertion errors (not import/type/runtime errors)
- Run: `deno test --allow-all tests/<TestFile>.test.ts` to verify

## What you must NOT do:
- Do NOT implement any logic. Method bodies should be empty or throw "not implemented"
- Do NOT modify existing tests
- Do NOT change existing passing behavior

## Testing style:
- Favor state-machine and transition-based tests
- Model: node state + inputs -> output blocks and side effects
- Use descriptive test names that state the invariant being tested
- Each test should test ONE thing

## Scaffold context:
- Runtime: Deno + TypeScript
- Test command: `deno test --allow-all tests/<file>.test.ts`
- Type check: `deno check src/core/<file>.ts`
- Source files: `src/core/`
- Test files: `tests/`
- Keep modules encapsulated; use provider interfaces for dependencies
- Do NOT use Context or assume BlockType internals -- access through providers

## Iteration:
Keep iterating until:
1. `deno check` passes on all new/modified source files
2. ALL new tests fail with assertion errors (not compilation or import errors)

Report back with: files created/modified, test count, and confirmation of the above.
```

Provide the specific test list after the instructions. Be precise about what each test should assert.

---

## Step 5: Verify Tests

When the test subagent finishes, verify yourself:

1. Run `deno check` on all new/modified source files
2. Run the tests and confirm ALL new tests fail with assertion errors
3. Confirm no existing tests were broken

If anything is wrong, fix it or re-launch the subagent with corrections.

---

## Step 6: Launch Implementation Subagent

Launch a subagent to implement the module. Give it:
1. The path(s) to the updated/new protocol docs
2. The path(s) to the test files (tests are the spec in executable form)
3. A plan of what needs implementing, with any key concerns or gotchas
4. The Scaffold context below

The subagent's instructions:

```
You are implementing a Scaffold protocol module. The docs and tests already exist.
Your job is to make all tests pass.

## What you MUST do:
- Read the protocol docs provided (they are the spec)
- Read the test files (they define expected behavior)
- Implement the module logic
- Ensure ALL tests pass: `deno test --allow-all tests/<TestFile>.test.ts`
- Ensure `deno check` passes on all modified files

## What you must NOT do:
- Do NOT modify test files. If you believe a test is wrong, stop and ask the
  parent agent (use the SendMessage tool to message the parent) explaining:
  (a) which test, (b) what it expects, (c) why you think it's wrong,
  (d) what you think it should expect instead. The parent will decide.
- Do NOT add features beyond what the tests require
- Do NOT refactor unrelated code

## Coding style:
- Keep modules encapsulated; use provider interfaces for dependencies
- Do NOT use Context or assume BlockType internals -- access through providers
- Glue code using Context should be minimal
- Prefer simple, elegant solutions
- Add comments only where logic isn't self-evident

## Scaffold context:
- Runtime: Deno + TypeScript
- Test command: `deno test --allow-all tests/<file>.test.ts`
- Full test suite: `deno task test`
- Source files: `src/core/`
- Keep modules encapsulated; use provider interfaces for dependencies

## Iteration:
Keep iterating until ALL tests pass. Run the specific test file after each change.
When done, also run `deno task test` to make sure nothing else broke.

Report back with: files modified, summary of implementation approach, and test results.
```

---

## Step 7: Verify Implementation

When the implementation subagent finishes, verify yourself:

1. Run the specific test file -- all tests should pass
2. Run `deno task test` -- no regressions
3. Read the implementation and do a sanity check:
   - Does it match the protocol docs?
   - Is it simple and elegant?
   - Are there obvious bugs or missed edge cases?
   - Is it properly encapsulated?

If anything looks incorrect, message the implementation subagent with specific fixes. Repeat until satisfied.

---

## Step 8: Format, Lint, Commit

1. Run `deno fmt` on all new/modified files
2. Run `deno lint` on all new/modified files and fix any issues
3. Run `deno task test` one final time
4. Create a commit with a clear message describing what was added/changed

---

## Anti-Patterns

- **Don't skip Steps 1-2.** The docs are the spec. Writing tests against a vague understanding produces vague tests.
- **Don't let subagents invent API surface.** You design the API (Step 3). Subagents implement your design.
- **Don't hand-wave incentives.** If you can't explain why honest behavior is profitable, the mechanism is incomplete.
- **Don't let a test modification slide without scrutiny.** If the implementation subagent says a test is wrong, think carefully. Usually the test is right and the implementation needs to change. Sometimes the test misunderstood the spec. Rarely, the spec needs updating -- and if so, go back to Step 2.
- **Don't proceed past a gate without user confirmation.**

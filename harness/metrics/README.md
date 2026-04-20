# harness/metrics/

Committed metrics from the canonical evaluation runs.

## Files

- `evaluation.json` -- structured report from the latest
  `deno run harness/analysis/analyzer.ts --config evaluation` run.
  Overwritten each run. Diff across runs via `git log -p evaluation.json`.
- `evaluation.txt` -- human-readable rendering of the same report.
  Easier to diff line-by-line in review.

## Lifecycle

1. Run the evaluation config end-to-end (see
   [`../README.md`](../README.md) quick start).
2. Run `harness/analysis/analyzer.ts <run-id>`; both files are
   overwritten.
3. `git diff harness/metrics/evaluation.txt` to review the delta.
4. Commit with a message naming the cause (threshold edit, behavior
   change, protocol change, etc.) -- not "update metrics".

## Format

See [`docs/harness/analyzer.md`](../../docs/harness/analyzer.md) for
the full description of:

- Buffer semantics (`1 - value / pass` or `value / pass - 1`)
- Classification (PASS / WARN / FAIL / not-classified)
- Threshold direction inference (pass < fail = lower is better)

## Initial state

The first committed `evaluation.json` is an empty shell produced
without a real postgres run. It shows the file structure so diffs
against the first real analyzer output are easy to read; until then
the metric list and classifications are intentionally empty.

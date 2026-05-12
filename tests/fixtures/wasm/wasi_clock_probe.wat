;; Minimal WASI snapshot preview 1 program for the shim's batch-1 tests.
;;
;; Imports `clock_time_get` from `wasi_snapshot_preview1` and calls it once
;; in `_start` to read REALTIME into offset 100 of its own memory. Returns
;; (i.e. does NOT call proc_exit) so the shim's `run` returns normally.
;;
;; Used by tests that verify the shim's clock_time_get implementation:
;;   - The program's clock_time_get call lands on the shim's exported
;;     `clock_time_get`, which writes the 8-byte LE u64 via
;;     `program_mem.write_bytes` into THIS module's memory at offset 100.
;;   - The test then inspects the program's memory[100..108] to verify the
;;     deterministic timestamp (block timestamp ms × 1_000_000).

(module
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))

  ;; Own memory; the shim imports this via `program:memory@write`.
  (memory (export "memory") 1)

  (func (export "_start")
    ;; clock_time_get(CLOCK_REALTIME=0, precision=0, dst_ptr=100) -> errno (ignored)
    (drop (call $clock_time_get (i32.const 0) (i64.const 0) (i32.const 100)))))

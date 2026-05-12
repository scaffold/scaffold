;; Calls proc_exit(7) so the shim rejects with "WASI proc_exit: 7".
;; Used to verify nonzero exits route through scaffold_env.reject.

(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (call $proc_exit (i32.const 7))))

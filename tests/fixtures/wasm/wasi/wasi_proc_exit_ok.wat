;; wasi_proc_exit_ok: exercise proc_exit(0) -- clean termination, no scaffold
;; host calls. Trace tail expected: `< exit ok`.

(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (func (export "_start")
    (call $proc_exit (i32.const 0))))

;; Calls args_sizes_get and stores the two u32 results in its own memory at
;; offsets 100 (argc) and 104 (argv_buf_size). Returns; shim's run unwinds.
;; v1 shim has empty default argv -- both should read back as 0.

(module
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $args_sizes_get (i32.const 100) (i32.const 104)))))

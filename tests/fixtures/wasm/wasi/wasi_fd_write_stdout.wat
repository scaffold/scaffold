;; wasi_fd_write_stdout: exercise fd_write(fd=1) -- bytes go to stdout, which
;; defaults to /out/debug (logger sink, no scaffold_env emit). The point is to
;; verify the shim correctly fetches the iovec table and the buffer bytes
;; from program memory; the snapshot will capture the cross-memory hops.
;;
;; Memory layout:
;;   [0..5)    "hello" string bytes
;;   [16..24)  iovec { buf=0, buf_len=5 }
;;   [32..36)  out_nwritten (written by shim)

(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "hello")

  (func (export "_start")
    ;; Build iovec at offset 16: { buf=0, buf_len=5 }.
    (i32.store (i32.const 16) (i32.const 0))
    (i32.store (i32.const 20) (i32.const 5))
    ;; fd_write(fd=1, iovs_ptr=16, iovs_len=1, out_nwritten=32). Discard errno.
    (drop (call $fd_write
      (i32.const 1)
      (i32.const 16)
      (i32.const 1)
      (i32.const 32)))
    (call $proc_exit (i32.const 0))))

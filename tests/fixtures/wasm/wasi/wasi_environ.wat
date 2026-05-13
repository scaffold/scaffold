;; wasi_environ: environ_sizes_get + environ_get -- read env[0] and write to
;; /out/record/env0.
;;
;; wasi_setup pins env = { "FOO": "bar" } (encoded as "FOO=bar\0", 8 bytes
;; including NUL). We write the first 7 bytes ("FOO=bar") to /out/record/env0.
;;
;; Memory layout:
;;   [0..11)    path "record/env0" (11 bytes)
;;   [16..20)   envc (out)
;;   [20..24)   env_buf_size (out)
;;   [32..40)   write iovec { buf=128, buf_len=7 }
;;   [48..52)   out_fd
;;   [56..60)   out_nwritten
;;   [64..72)   env pointer table (1 ptr, 4 bytes; reserve 8)
;;   [128..136) env string buffer ("FOO=bar\0", 8 bytes)

(module
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get"
    (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "record/env0")

  (func (export "_start")
    (local $fd i32)

    (drop (call $environ_sizes_get (i32.const 16) (i32.const 20)))
    (drop (call $environ_get (i32.const 64) (i32.const 128)))

    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 11)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 48)))
    (local.set $fd (i32.load (i32.const 48)))

    (i32.store (i32.const 32) (i32.const 128))
    (i32.store (i32.const 36) (i32.const 7))
    (drop (call $fd_write
      (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 56)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

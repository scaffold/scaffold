;; wasi_random: random_get(buf, 8) -- first 8 bytes of the deterministic PRNG
;; stream. Result written to /out/record/rng. The snapshot pins the bytes;
;; this fixture itself bakes no expected value.
;;
;; Memory layout:
;;   [0..10)    path "record/rng" (10 bytes)
;;   [16..24)   PRNG buffer (8 bytes, written by random_get)
;;   [32..40)   iovec { buf=16, buf_len=8 }
;;   [48..52)   out_fd
;;   [56..60)   out_nwritten

(module
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "record/rng")

  (func (export "_start")
    (local $fd i32)

    ;; random_get(buf=16, len=8).
    (drop (call $random_get (i32.const 16) (i32.const 8)))

    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 10)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 48)))
    (local.set $fd (i32.load (i32.const 48)))

    (i32.store (i32.const 32) (i32.const 16))
    (i32.store (i32.const 36) (i32.const 8))
    (drop (call $fd_write
      (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 56)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

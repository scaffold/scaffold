;; wasi_clock_monotonic: clock_time_get(MONOTONIC=1) called twice. Counter
;; advances 1 ns per call. Both 8-byte u64 LE results (16 bytes total) are
;; concatenated and written to /out/record/mono.
;;
;; Memory layout:
;;   [0..11)    path "record/mono" (11 bytes)
;;   [16..24)   t1 (u64 LE)
;;   [24..32)   t2 (u64 LE)
;;   [32..40)   iovec { buf=16, buf_len=16 }
;;   [48..52)   out_fd
;;   [56..60)   out_nwritten

(module
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "record/mono")

  (func (export "_start")
    (local $fd i32)

    ;; Two MONOTONIC reads, t1 at [16..24), t2 at [24..32).
    (drop (call $clock_time_get (i32.const 1) (i64.const 0) (i32.const 16)))
    (drop (call $clock_time_get (i32.const 1) (i64.const 0) (i32.const 24)))

    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 11)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 48)))
    (local.set $fd (i32.load (i32.const 48)))

    ;; iovec at 32: { buf=16, buf_len=16 } (covers both u64s).
    (i32.store (i32.const 32) (i32.const 16))
    (i32.store (i32.const 36) (i32.const 16))
    (drop (call $fd_write
      (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 56)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

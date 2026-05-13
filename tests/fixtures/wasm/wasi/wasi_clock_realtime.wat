;; wasi_clock_realtime: clock_time_get(REALTIME=0) -- returns timestamp x 1e6
;; nanoseconds. The 8-byte u64 LE result is written to /out/record/clock.
;;
;; Default preopens: /out=4. PLAN names the params "clock".
;;
;; Memory layout:
;;   [0..12)    path "record/clock" (12 bytes)
;;   [16..24)   ns_out (u64 LE, written by clock_time_get)
;;   [32..40)   iovec { buf=16, buf_len=8 }
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

  (data (i32.const 0) "record/clock")

  (func (export "_start")
    (local $fd i32)

    ;; clock_time_get(clock_id=0 REALTIME, precision=0, ts_ptr=16).
    (drop (call $clock_time_get (i32.const 0) (i64.const 0) (i32.const 16)))

    ;; path_open(/out, "record/clock", O_CREAT) -> out_fd at 48.
    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 12)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 48)))
    (local.set $fd (i32.load (i32.const 48)))

    ;; iovec at 32: { buf=16, buf_len=8 }.
    (i32.store (i32.const 32) (i32.const 16))
    (i32.store (i32.const 36) (i32.const 8))
    (drop (call $fd_write
      (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 56)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

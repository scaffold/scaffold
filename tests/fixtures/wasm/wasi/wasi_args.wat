;; wasi_args: args_sizes_get + args_get -- read argv[0] from the populated
;; buffer and write it to /out/record/argv0.
;;
;; wasi_setup pins argv = ["asc0123"]: a single 7-byte string. After
;; args_get, the argv pointer table at offset 64 holds 1 i32 (pointer to
;; "asc0123\0" within the argv_buf). The argv_buf at offset 128 holds the
;; bytes "asc0123\0" (8 bytes including the NUL). We write the first 7
;; bytes (excluding NUL) to /out/record/argv0.
;;
;; Memory layout:
;;   [0..12)    path "record/argv0" (12 bytes)
;;   [16..20)   argc (out)
;;   [20..24)   argv_buf_size (out)
;;   [32..40)   write iovec { buf=128, buf_len=7 }
;;   [48..52)   out_fd
;;   [56..60)   out_nwritten
;;   [64..72)   argv pointer table (1 ptr, 4 bytes; we reserve 8 for safety)
;;   [128..136) argv string buffer ("asc0123\0", 8 bytes)

(module
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get"
    (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "record/argv0")

  (func (export "_start")
    (local $fd i32)

    ;; args_sizes_get(out_argc=16, out_buf_size=20). We do not consume the
    ;; sizes (the layout below assumes the documented argv = ["asc0123"]),
    ;; but the call exercises the host path.
    (drop (call $args_sizes_get (i32.const 16) (i32.const 20)))

    ;; args_get(argv_ptrs=64, argv_buf=128).
    (drop (call $args_get (i32.const 64) (i32.const 128)))

    ;; Open /out/record/argv0 with O_CREAT.
    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 12)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 48)))
    (local.set $fd (i32.load (i32.const 48)))

    ;; Write iovec at 32: { buf=128, buf_len=7 } (skip the NUL at byte 7).
    (i32.store (i32.const 32) (i32.const 128))
    (i32.store (i32.const 36) (i32.const 7))
    (drop (call $fd_write
      (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 56)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

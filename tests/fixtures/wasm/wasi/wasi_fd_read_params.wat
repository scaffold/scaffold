;; wasi_fd_read_params: open /in/params, read up to 256 bytes (mock provides
;; "hello-from-params" or similar), then write the bytes to /out/record/echo.
;; The /out/record/echo close triggers emit_output { params: "echo", body }.
;;
;; Default preopens: /in=3, /out=4. /in/params is served from mock.params
;; without a scaffold_env round-trip (per PLAN.md note).
;;
;; Memory layout:
;;   [0..6)     path "params" (6 bytes; opens against /in dirfd)
;;   [16..20)   path "echo"   (used as "record/echo" via composite below)
;;   [32..42)   path "record/echo" (10 bytes; opens against /out dirfd)
;;   [256..512) read scratch buffer (256 bytes)
;;   [1024..1032) read iovec { buf=256, buf_len=256 }
;;   [1040..1048) write iovec { buf=256, buf_len=nread }
;;   [1056..1060) out_fd
;;   [1064..1068) out_nread / out_nwritten

(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0)  "params")
  (data (i32.const 32) "record/echo")

  (func (export "_start")
    (local $in_fd i32) (local $out_fd i32) (local $nread i32)

    ;; Open /in/params. dirfd = 3 (/in), oflags = 0 (read-only).
    (drop (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 6)
      (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 1056)))
    (local.set $in_fd (i32.load (i32.const 1056)))

    ;; Read iovec at 1024: { buf=256, buf_len=256 }.
    (i32.store (i32.const 1024) (i32.const 256))
    (i32.store (i32.const 1028) (i32.const 256))
    (drop (call $fd_read
      (local.get $in_fd) (i32.const 1024) (i32.const 1) (i32.const 1064)))
    (local.set $nread (i32.load (i32.const 1064)))
    (drop (call $fd_close (local.get $in_fd)))

    ;; Open /out/record/echo with O_CREAT. dirfd = 4 (/out).
    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 32) (i32.const 11)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 1056)))
    (local.set $out_fd (i32.load (i32.const 1056)))

    ;; Write iovec at 1040: { buf=256, buf_len=nread }.
    (i32.store (i32.const 1040) (i32.const 256))
    (i32.store (i32.const 1044) (local.get $nread))
    (drop (call $fd_write
      (local.get $out_fd) (i32.const 1040) (i32.const 1) (i32.const 1064)))

    ;; Close triggers emit_output.
    (drop (call $fd_close (local.get $out_fd)))
    (call $proc_exit (i32.const 0))))

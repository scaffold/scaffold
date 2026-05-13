;; wasi_fd_write_record: open /out/record/foo, write "hello", close. The
;; close triggers the shim's emit_output (verifier = RECORD_CONTRACT,
;; params = "foo", body = "hello").
;;
;; Default preopens give /in=3, /out=4, /scratch=5, /dev=6 (stdio at 0..2).
;; We path_open(dirfd=4, path="record/foo", oflags=O_CREAT=0x1).
;;
;; Memory layout:
;;   [0..10)   path "record/foo" (10 bytes)
;;   [16..21)  body "hello"
;;   [32..40)  iovec { buf=16, buf_len=5 }
;;   [48..52)  out_fd from path_open
;;   [56..60)  out_nwritten

(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0)  "record/foo")
  (data (i32.const 16) "hello")

  (func (export "_start")
    (local $fd i32)
    ;; path_open(dirfd=4 (/out), dirflags=0, path_ptr=0, path_len=10,
    ;;           oflags=CREAT (0x1), rights_base=ALL, rights_inheriting=ALL,
    ;;           fdflags=0, out_fd=48).
    (drop (call $path_open
      (i32.const 4)            ;; dirfd = /out
      (i32.const 0)            ;; dirflags
      (i32.const 0)            ;; path_ptr
      (i32.const 10)           ;; path_len
      (i32.const 1)            ;; oflags = O_CREAT
      (i64.const -1)           ;; rights_base = all bits set; shim clamps
      (i64.const -1)           ;; rights_inheriting
      (i32.const 0)            ;; fdflags
      (i32.const 48)))         ;; out_fd
    (local.set $fd (i32.load (i32.const 48)))

    ;; iovec at offset 32: { buf=16, buf_len=5 }
    (i32.store (i32.const 32) (i32.const 16))
    (i32.store (i32.const 36) (i32.const 5))
    (drop (call $fd_write
      (local.get $fd)
      (i32.const 32)
      (i32.const 1)
      (i32.const 56)))

    ;; close triggers emit_output.
    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

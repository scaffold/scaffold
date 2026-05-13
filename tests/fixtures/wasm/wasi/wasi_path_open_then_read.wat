;; wasi_path_open_then_read: open /scratch/foo with O_CREAT, write "X", close,
;; reopen for read, read 1 byte, close. Then open /out/record/scratch_byte
;; and write the read byte. Verifies the in-memory memfs round-trip on
;; /scratch (no scaffold_env round-trip for the memfs steps).
;;
;; Default preopens: /out=4, /scratch=5.
;;
;; Memory layout:
;;   [0..3)     path "foo" (3 bytes; opens against /scratch dirfd)
;;   [16..35)   path "record/scratch_byte" (19 bytes)
;;   [40..41)   write payload "X" (1 byte)
;;   [48..56)   write iovec { buf=40, buf_len=1 }
;;   [56..64)   read iovec  { buf=200, buf_len=1 }
;;   [64..72)   write-back iovec { buf=200, buf_len=1 }
;;   [80..84)   out_fd (reused)
;;   [88..92)   out_nread / out_nwritten
;;   [200..201) read scratch byte

(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0)  "foo")
  (data (i32.const 16) "record/scratch_byte")
  (data (i32.const 40) "X")

  (func (export "_start")
    (local $fd i32)

    ;; Open /scratch/foo with O_CREAT (dirfd=5).
    (drop (call $path_open
      (i32.const 5) (i32.const 0) (i32.const 0) (i32.const 3)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 80)))
    (local.set $fd (i32.load (i32.const 80)))

    ;; write iovec at 48: { buf=40, buf_len=1 }
    (i32.store (i32.const 48) (i32.const 40))
    (i32.store (i32.const 52) (i32.const 1))
    (drop (call $fd_write
      (local.get $fd) (i32.const 48) (i32.const 1) (i32.const 88)))
    (drop (call $fd_close (local.get $fd)))

    ;; Reopen /scratch/foo for reading (oflags=0).
    (drop (call $path_open
      (i32.const 5) (i32.const 0) (i32.const 0) (i32.const 3)
      (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 80)))
    (local.set $fd (i32.load (i32.const 80)))

    ;; read iovec at 56: { buf=200, buf_len=1 }
    (i32.store (i32.const 56) (i32.const 200))
    (i32.store (i32.const 60) (i32.const 1))
    (drop (call $fd_read
      (local.get $fd) (i32.const 56) (i32.const 1) (i32.const 88)))
    (drop (call $fd_close (local.get $fd)))

    ;; Open /out/record/scratch_byte (dirfd=4) and write the byte we read.
    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 16) (i32.const 19)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 80)))
    (local.set $fd (i32.load (i32.const 80)))

    ;; write-back iovec at 64: { buf=200, buf_len=1 }
    (i32.store (i32.const 64) (i32.const 200))
    (i32.store (i32.const 68) (i32.const 1))
    (drop (call $fd_write
      (local.get $fd) (i32.const 64) (i32.const 1) (i32.const 88)))
    (drop (call $fd_close (local.get $fd)))

    (call $proc_exit (i32.const 0))))

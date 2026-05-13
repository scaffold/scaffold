;; wasi_fd_readdir: readdir on / -- iterate ["in", "out", "scratch", "dev"]
;; (or whatever the root preopen exposes), join names with ',', write to
;; /out/record/dirents.
;;
;; Requires wasi_setup.preopens to put / at fd 3 (e.g. preopens = ["/", "/out"]
;; so / is fd 3 and /out is fd 4). With root only holding ~4 short entries,
;; a single fd_readdir into a 512-byte buffer captures EOF in one shot.
;;
;; WASI dirent layout (24-byte header + name):
;;   [+0..+8)   d_next   (u64 cookie of the *next* entry)
;;   [+8..+16)  d_ino    (u64; ignored)
;;   [+16..+20) d_namlen (u32)
;;   [+20..+21) d_type   (u8; ignored)
;;   [+21..+24) padding
;;   [+24..+24+d_namlen) name bytes (no NUL)
;;
;; Memory layout:
;;   [0..14)    path "record/dirents" (14 bytes)
;;   [16..24)   write iovec { buf=2048, buf_len=joined_len }
;;   [32..36)   bufused (out from fd_readdir)
;;   [40..44)   out_fd
;;   [48..52)   out_nwritten
;;   [512..1024) readdir scratch buffer (512 bytes)
;;   [2048..)   joined names buffer ("in,out,scratch,dev")

(module
  (import "wasi_snapshot_preview1" "fd_readdir"
    (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  (memory (export "memory") 1)

  (data (i32.const 0) "record/dirents")

  (func (export "_start")
    (local $bufused i32)
    (local $offset i32)
    (local $namlen i32)
    (local $out_pos i32)
    (local $i i32)
    (local $fd i32)

    ;; fd_readdir(fd=3 (root preopen), buf=512, buf_len=512, cookie=0,
    ;;            out_bufused=32). Single call assumes the root fits.
    (drop (call $fd_readdir
      (i32.const 3) (i32.const 512) (i32.const 512)
      (i64.const 0) (i32.const 32)))
    (local.set $bufused (i32.load (i32.const 32)))

    ;; Walk the dirent buffer, copying each name to [2048..) followed by ','.
    (local.set $offset (i32.const 0))
    (local.set $out_pos (i32.const 2048))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $offset) (local.get $bufused)))
        ;; namlen = u32 at offset+16
        (local.set $namlen
          (i32.load (i32.add (i32.const 512)
                             (i32.add (local.get $offset) (i32.const 16)))))
        ;; Bail if the header alone overruns the buffer (truncated entry).
        (br_if $done
          (i32.gt_u (i32.add (local.get $offset)
                             (i32.add (i32.const 24) (local.get $namlen)))
                    (local.get $bufused)))

        ;; Copy name bytes from src=512+offset+24 to dst=out_pos.
        (memory.copy
          (local.get $out_pos)
          (i32.add (i32.const 512)
                   (i32.add (local.get $offset) (i32.const 24)))
          (local.get $namlen))
        (local.set $out_pos (i32.add (local.get $out_pos) (local.get $namlen)))

        ;; Append ','.
        (i32.store8 (local.get $out_pos) (i32.const 44))
        (local.set $out_pos (i32.add (local.get $out_pos) (i32.const 1)))

        ;; Advance to next dirent: offset += 24 + namlen.
        (local.set $offset
          (i32.add (local.get $offset)
                   (i32.add (i32.const 24) (local.get $namlen))))
        (br $next)))

    ;; Strip the trailing comma (if we wrote anything).
    (if (i32.gt_u (local.get $out_pos) (i32.const 2048))
      (then (local.set $out_pos (i32.sub (local.get $out_pos) (i32.const 1)))))

    ;; Open /out/record/dirents. /out is fd 4 (preopens = ["/", "/out"]).
    (drop (call $path_open
      (i32.const 4) (i32.const 0) (i32.const 0) (i32.const 14)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0)
      (i32.const 40)))
    (local.set $fd (i32.load (i32.const 40)))

    ;; iovec at 16: { buf=2048, buf_len=out_pos-2048 }.
    (i32.store (i32.const 16) (i32.const 2048))
    (i32.store (i32.const 20) (i32.sub (local.get $out_pos) (i32.const 2048)))
    (drop (call $fd_write
      (local.get $fd) (i32.const 16) (i32.const 1) (i32.const 48)))

    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0))))

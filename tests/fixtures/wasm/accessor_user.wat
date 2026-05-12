;; Layer that imports cross-memory accessor functions to read from / write
;; to another layer's exported memory. Models the WASI-shim pattern: the
;; shim owns its own memory but needs to read/write the program layer's
;; memory via JS-synthesised memcpy closures.
;;
;; Signatures (program_mem.* -> "<other_layer>:memory@read"/"@write"):
;;   read_bytes  (target_off i32, peer_off i32, len i32) -> void
;;     Copies bytes FROM target memory[target_off..+len]
;;                  INTO this layer's memory[peer_off..+len].
;;   write_bytes (target_off i32, peer_off i32, len i32) -> void
;;     Copies bytes FROM this layer's memory[peer_off..+len]
;;                  INTO target memory[target_off..+len].

(module
  (import "program_mem" "read_bytes"
    (func $read_bytes (param i32 i32 i32)))
  (import "program_mem" "write_bytes"
    (func $write_bytes (param i32 i32 i32)))

  (memory (export "memory") 1 4096)

  ;; Bake user-side payload at offset 64: "user-side-payload-content" (25 bytes).
  (data (i32.const 64) "user-side-payload-content")

  (func (export "do_read") (param $tgt i32) (param $peer i32) (param $len i32)
    (call $read_bytes (local.get $tgt) (local.get $peer) (local.get $len)))

  (func (export "do_write") (param $tgt i32) (param $peer i32) (param $len i32)
    (call $write_bytes (local.get $tgt) (local.get $peer) (local.get $len))))

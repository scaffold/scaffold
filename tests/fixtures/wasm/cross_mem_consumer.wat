;; Imports another layer's exported memory and reads bytes from it. Emits
;; those bytes as an Output's body. Has no memory of its own (just imports
;; one). Demonstrates the cross-memory access pattern that the WASI shim
;; will use to read program bytes.
;;
;; The data_owner fixture stores "hello-from-data-owner" (21 bytes) at
;; offset 256 of its memory. This consumer copies those bytes from
;; offset 256 to offset 1080 (its own Output body slot) within the same
;; (imported) memory and emits the result.

(module
  (import "scaffold_env" "emit_output" (func $emit_output (param i32 i32)))
  (import "other_mem" "memory" (memory 1 4096 shared))

  (global $next (mut i32) (i32.const 8192))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; Output layout at offset 1024:
  ;;   [1024..1056): contract = ZERO_HASH (zero-initialised by Memory)
  ;;   [1056..1060): params length = 0
  ;;   [1060..1076): value = 0 (i128 LE)
  ;;   [1076..1080): body length = 21 (u32 LE)
  ;;   [1080..1101): body bytes copied from offset 256
  (func (export "run")
    (i32.store (i32.const 1056) (i32.const 0))
    (i32.store (i32.const 1076) (i32.const 21))
    (memory.copy (i32.const 1080) (i32.const 256) (i32.const 21))
    (call $emit_output (i32.const 1024) (i32.const 77))))

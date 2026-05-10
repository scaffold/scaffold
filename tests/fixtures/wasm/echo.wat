;; Echo contract: takes params bytes, emits one Output wire record carrying
;; those bytes as the body. The verifier is { contract: ZERO_HASH,
;; params: "echo" }; the test asserts the env saw exactly that emit.
;;
;; Output wire layout (matches WasmWireCodec.encodeOutput):
;;   [ 0..32):  verifier.contract -- 32-byte hash (zero-filled, ZERO_HASH)
;;   [32..36):  verifier.params length = 4 (u32 LE)
;;   [36..40):  verifier.params = "echo"
;;   [40..56):  value = 0 (i128 LE)
;;   [56..60):  body length (u32 LE)            -- written at runtime
;;   [60..  ):  body bytes                      -- copied at runtime
;;
;; Linear memory is zero-initialised, so the 32 zero hash + the 16 zero
;; value bytes need no explicit data section. Only the "echo" params bytes
;; (plus their length prefix) are baked into the data section.

(module
  (import "scaffold_env" "params"      (func $params      (result i64)))
  (import "scaffold_env" "emit_output" (func $emit_output (param i32 i32)))
  (memory (export "memory") 1 4096 shared)

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "\04\00\00\00echo" — the 4-byte u32 length + the 4 ASCII bytes of "echo".
  (data (i32.const 32) "\04\00\00\00echo")

  (func (export "run")
    (local $packed i64) (local $src i32) (local $len i32)
    (local.set $packed (call $params))
    (local.set $src    (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32))))
    (local.set $len    (i32.wrap_i64 (local.get $packed)))
    ;; Body length (u32 LE) at offset 56
    (i32.store (i32.const 56) (local.get $len))
    ;; Body bytes copied to offset 60
    (memory.copy (i32.const 60) (local.get $src) (local.get $len))
    ;; Emit the Output: ptr=0, len = 60 + body_len
    (call $emit_output (i32.const 0) (i32.add (i32.const 60) (local.get $len)))))

;; Passthrough upper (primary) layer: imports emit_output under a deliberately
;; renamed namespace `renamed_ns`. The test's wasm_layers spec carries
;;   mapImports: { "renamed_ns.emit_output": "emit_output" }
;; on the primary entry, so this import resolves to the lower layer's flat
;; `emit_output` export.
;;
;; Behaviour: emit one Output identical to the existing echo fixture, but with
;; the body baked into the data section so the test doesn't need to thread
;; params through. The verifier is { contract: ZERO_HASH, params: "stack" },
;; value=0, body="passthrough-ok".
;;
;; Wire layout for the Output (see WasmWireCodec.encodeOutput):
;;   [ 0..32):  verifier.contract -- 32 zero bytes
;;   [32..36):  verifier.params length = 5 (u32 LE)
;;   [36..41):  verifier.params = "stack"
;;   [41..57):  value = 0 (i128 LE, 16 zero bytes)
;;   [57..61):  body length = 14 (u32 LE)
;;   [61..75):  body = "passthrough-ok"

(module
  (import "renamed_ns" "emit_output" (func $emit_output (param i32 i32)))
  (import "env" "memory" (memory 1 4096 shared))

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "\05\00\00\00stack" at offset 32: length-prefixed verifier params.
  (data (i32.const 32) "\05\00\00\00stack")
  ;; "\0e\00\00\00passthrough-ok" at offset 57: length-prefixed body.
  (data (i32.const 57) "\0e\00\00\00passthrough-ok")

  (func (export "run")
    (call $emit_output (i32.const 0) (i32.const 75))))

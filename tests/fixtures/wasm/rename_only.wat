;; Single-module contract that uses mapImports for a rename. Declares an
;; import from a non-standard namespace `renamed_env`; the test pins
;;   wasm_layers: [{ mapImports: { "renamed_env.emit_output": "emit_output" } }]
;; so the import resolves to scaffold_env's flat `emit_output`.
;;
;; Behaviour matches passthrough_upper.wat: emit one fixed Output.

(module
  (import "renamed_env" "emit_output" (func $emit_output (param i32 i32)))
  (import "env" "memory" (memory 1 4096 shared))

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "\06\00\00\00rename" at offset 32 (length-prefixed verifier params).
  (data (i32.const 32) "\06\00\00\00rename")
  ;; "\09\00\00\00rename-ok" at offset 58 (length-prefixed body; len=9).
  (data (i32.const 58) "\09\00\00\00rename-ok")

  (func (export "run")
    ;; Output total length: 32 + 4 + 6 + 16 + 4 + 9 = 71 bytes
    (call $emit_output (i32.const 0) (i32.const 71))))

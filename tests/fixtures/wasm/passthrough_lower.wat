;; Passthrough lower layer: imports scaffold_env.emit_output and re-exports it
;; under the flat name `emit_output`. Used by the WasmStacking test as the
;; layer between the host and the passthrough_upper primary.
;;
;; Imports `env.memory` (shared) so it shares one linear memory with all other
;; layers in the stack.

(module
  (import "scaffold_env" "emit_output" (func $upstream_emit_output (param i32 i32)))
  (import "env" "memory" (memory 1 4096 shared))

  ;; Re-exported flat (no namespace). The primary's mapImports binds
  ;; "<some_namespace>.emit_output" -> "emit_output" to resolve here.
  (func (export "emit_output") (param $p i32) (param $l i32)
    (call $upstream_emit_output (local.get $p) (local.get $l))))

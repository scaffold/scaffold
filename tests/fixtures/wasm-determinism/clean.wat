;; Already deterministic: imports env.memory, no banned ops, has version section.
;; Constructed by hand to be valid as-is (no transformation needed). The version
;; section is appended in the binary via `wat2wasm --custom-section`.
(module
  (import "env" "memory" (memory 1))
  (func $main (export "main") (param i32) (result i32)
    local.get 0
    i32.const 1
    i32.add)
)

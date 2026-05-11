;; Declares memory in the memory section (not imported). Transformer should
;; rewrite this into an env.memory import.
(module
  (memory 1)
  (func $main (export "main") (param i32) (result i32)
    local.get 0
    i32.const 1
    i32.add)
)

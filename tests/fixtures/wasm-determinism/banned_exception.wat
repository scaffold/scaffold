;; Uses `throw` (exception handling) -- BANNED.
(module
  (import "env" "memory" (memory 1))
  (tag $t (param i32))
  (func $bad (export "bad")
    i32.const 42
    throw $t)
)

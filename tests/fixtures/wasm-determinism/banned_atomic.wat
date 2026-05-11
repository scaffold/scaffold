;; Uses i32.atomic.load (under the 0xfe prefix). BANNED.
(module
  (import "env" "memory" (memory 1 1 shared))
  (func $bad (export "bad") (param i32) (result i32)
    local.get 0
    i32.atomic.load)
)

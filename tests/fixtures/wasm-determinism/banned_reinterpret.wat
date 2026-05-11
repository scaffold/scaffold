;; Uses f32.reinterpret_i32, which leaks float bits -- BANNED.
(module
  (import "env" "memory" (memory 1))
  (func $bad (export "bad") (param i32) (result f32)
    local.get 0
    f32.reinterpret_i32)
)

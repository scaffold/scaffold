;; Stores the result of an f32 add via a global -> memory path. Determinism
;; is verified by checking the memory bytes (the actual escape point).
(module
  (import "env" "memory" (memory 1))
  (global $g (mut f32) (f32.const 0))
  (func $set (export "set") (param $x f32)
    local.get $x
    local.get $x
    f32.add
    global.set $g
    i32.const 0
    global.get $g
    f32.store)
)

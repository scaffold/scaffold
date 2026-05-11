;; Sets an f32 global. Transformer should insert NaN canonicalization
;; before global.set.
(module
  (import "env" "memory" (memory 1))
  (global $g (mut f32) (f32.const 0))
  (func $set (export "set") (param $x f32)
    local.get $x
    local.get $x
    f32.add
    global.set $g)
)

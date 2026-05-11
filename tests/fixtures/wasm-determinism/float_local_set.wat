;; Performs an f32 division then stores into a local. Transformer should
;; insert NaN canonicalization before the local.set.
(module
  (import "env" "memory" (memory 1))
  (func $div (export "div") (param $a f32) (param $b f32) (result f32)
    (local $r f32)
    local.get $a
    local.get $b
    f32.div
    local.set $r
    local.get $r)
)

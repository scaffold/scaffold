;; Writes the result of an f32 division to memory at offset 0. Transformer
;; should canonicalize before the f32.store; the memory bytes are the
;; determinism-relevant escape (not the function return value).
(module
  (import "env" "memory" (memory 1))
  (func $div (export "div") (param $a f32) (param $b f32)
    (local $r f32)
    local.get $a
    local.get $b
    f32.div
    local.set $r
    i32.const 0
    local.get $r
    f32.store)
)

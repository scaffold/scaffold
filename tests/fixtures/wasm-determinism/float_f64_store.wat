;; Stores an f64 into memory. Transformer should insert NaN canonicalization
;; before f64.store.
(module
  (import "env" "memory" (memory 1))
  (func $store (export "store") (param $a f64) (param $b f64)
    i32.const 0
    local.get $a
    local.get $b
    f64.mul
    f64.store)
)

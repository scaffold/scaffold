;; Tests copysign canonicalization. The second arg to copysign is the result
;; of an arithmetic op that produces a NaN with engine-chosen sign bit. If
;; uncanonicalized, the sign bit leaks into the (non-NaN) result. After
;; canonicalize, the sign bit is 0 (canonical NaN's sign).
(module
  (import "env" "memory" (memory 1))
  (func $cs (export "cs") (param $a f32)
    ;; second arg: produce a NaN via 0/0
    i32.const 0
    f32.const 1.0                        ;; first arg to copysign
    f32.const 0
    f32.const 0
    f32.div                              ;; produces NaN with engine-chosen sign
    f32.copysign                         ;; transformer canonicalizes the NaN before this op
    f32.store)
)

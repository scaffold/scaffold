;; Uses f32x4.add (SIMD float arithmetic). BANNED because v128 with float
;; lanes leaks NaN bits at the v128 escape points.
(module
  (import "env" "memory" (memory 1))
  (func $bad (export "bad") (param v128 v128) (result v128)
    local.get 0
    local.get 1
    f32x4.add)
)

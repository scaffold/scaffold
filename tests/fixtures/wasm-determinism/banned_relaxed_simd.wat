;; Uses f32x4.relaxed_madd (relaxed SIMD, 0xfd 0x105) -- BANNED.
(module
  (import "env" "memory" (memory 1))
  (func $bad (export "bad") (param v128 v128 v128) (result v128)
    local.get 0
    local.get 1
    local.get 2
    f32x4.relaxed_madd)
)

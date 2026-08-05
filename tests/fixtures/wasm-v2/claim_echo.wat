;; run: set_result(claim()) -- the first genuinely blocking import.
(module
  (import "scaffold_env" "claim" (func $claim (result i64)))
  (import "scaffold_env" "set_result" (func $set_result (param i32 i32)))
  (memory (export "memory") 1)
  (global $next (mut i32) (i32.const 16))
  (func $alloc (export "alloc") (param $len i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $next))
    (global.set $next (i32.add (local.get $ptr) (local.get $len)))
    (local.get $ptr))
  (func (export "run")
    (local $packed i64)
    (local.set $packed (call $claim))
    (call $set_result
      (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32)))
      (i32.wrap_i64 (local.get $packed)))))

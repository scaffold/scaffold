;; run: reject("nope") -- rejection propagation.
(module
  (import "scaffold_env" "reject" (func $reject (param i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "nope")
  (global $next (mut i32) (i32.const 16))
  (func $alloc (export "alloc") (param $len i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $next))
    (global.set $next (i32.add (local.get $ptr) (local.get $len)))
    (local.get $ptr))
  (func (export "run")
    (call $reject (i32.const 8) (i32.const 4))))

;; run: unreachable -- a crash, distinct from a rejection.
(module
  (memory (export "memory") 1)
  (global $next (mut i32) (i32.const 16))
  (func $alloc (export "alloc") (param $len i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $next))
    (global.set $next (i32.add (local.get $ptr) (local.get $len)))
    (local.get $ptr))
  (func (export "run")
    unreachable))

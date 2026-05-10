;; Reject contract: immediately calls scaffold_env.reject with a fixed
;; reason string. Used to verify reject propagation across all transports.

(module
  (import "scaffold_env" "reject" (func $reject (param i32 i32)))
  (memory (export "memory") 1 4096 shared)

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  (data (i32.const 0) "rejected on purpose")

  (func (export "run")
    (call $reject (i32.const 0) (i32.const 19))
    unreachable))

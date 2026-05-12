;; Layer that owns and exports a memory with some baked data at offset 256.
;; Used by cross_mem_consumer to demonstrate cross-layer memory access.

(module
  (memory (export "memory") 1 4096 shared)
  (data (i32.const 256) "hello-from-data-owner")
  ;; alloc is required if this layer is ever chosen as the entry, but not
  ;; used here (consumer is the entry in the test). Keep it cheap.
  (global $next (mut i32) (i32.const 4096))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p)))

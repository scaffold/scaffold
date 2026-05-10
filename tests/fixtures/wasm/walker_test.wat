;; Walker test: takes (params_ptr, params_len), emits one scaffold_walker
;; call with a fixed key/value/descriptor. The test asserts the host
;; received that emit.

(module
  (import "scaffold_walker" "emit_string"
    (func $emit_string (param i32 i32 i32 i32 i32 i32)))
  (memory (export "memory") 1 4096 shared)

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "name" at offset 0, "Joel" at offset 8, descriptor JSON at offset 16
  (data (i32.const 0)  "name")
  (data (i32.const 8)  "Joel")
  (data (i32.const 16) "{\"type\":\"string\",\"shortDescription\":\"Player name\"}")

  (func (export "walk_params") (param $_p i32) (param $_l i32)
    ;; key="name" (4), value="Joel" (4), desc=JSON (50)
    (call $emit_string
      (i32.const 0) (i32.const 4)
      (i32.const 8) (i32.const 4)
      (i32.const 16) (i32.const 50))))

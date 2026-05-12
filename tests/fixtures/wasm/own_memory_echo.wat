;; Same shape as echo.wat, but declares its own exported memory instead of
;; importing one from `env`. Used to test the "module owns its memory"
;; path: no `base.memories` declaration is needed in the modules graph;
;; the host bridge reads the entry layer's exported `memory`.
;;
;; Output wire layout (same as echo.wat). See echo.wat for byte map.

(module
  (import "scaffold_env" "params"      (func $params      (result i64)))
  (import "scaffold_env" "emit_output" (func $emit_output (param i32 i32)))
  (memory (export "memory") 1 4096 shared)

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  (data (i32.const 32) "\04\00\00\00echo")

  (func (export "run")
    (local $packed i64) (local $src i32) (local $len i32)
    (local.set $packed (call $params))
    (local.set $src    (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32))))
    (local.set $len    (i32.wrap_i64 (local.get $packed)))
    (i32.store (i32.const 56) (local.get $len))
    (memory.copy (i32.const 60) (local.get $src) (local.get $len))
    (call $emit_output (i32.const 0) (i32.add (i32.const 60) (local.get $len)))))

;; Uses memory.grow but does not import env.abstain. The transformer cannot
;; insert the abstain guard, so this must be rejected (return -1).
(module
  (import "env" "memory" (memory 1))
  (func $do_grow (export "do_grow") (param $pages i32) (result i32)
    local.get $pages
    memory.grow)
)

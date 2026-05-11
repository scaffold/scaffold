;; Uses memory.grow. Imports env.abstain so the transformer can wrap the grow
;; site with the abstain-on-fail guard.
(module
  (import "env" "memory" (memory 1))
  (import "env" "abstain" (func $abstain))
  (func $do_grow (export "do_grow") (param $pages i32) (result i32)
    local.get $pages
    memory.grow)
)

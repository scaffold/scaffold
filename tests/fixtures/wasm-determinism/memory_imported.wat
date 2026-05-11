;; Already imports env.memory but is missing the version section: tool should
;; add the version section and return a transformed output. Re-running the tool
;; on the output should return 0.
(module
  (import "env" "memory" (memory 1))
  (func $main (export "main") (result i32)
    i32.const 42)
)

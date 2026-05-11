;; Declares shared memory -- BANNED (atomics' gateway).
(module
  (memory 1 1 shared)
  (func $main (export "main") (result i32)
    i32.const 0)
)

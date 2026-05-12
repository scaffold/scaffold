;; Calls random_get(buf=100, buf_len=32) to fill a 32-byte buffer with
;; deterministic PRNG output (seeded from contract_hash). Returns.

(module
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $random_get (i32.const 100) (i32.const 32)))))

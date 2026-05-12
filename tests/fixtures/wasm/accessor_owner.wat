;; Layer that owns and exports a memory with some baked data. Used as the
;; "target memory" for cross-memory accessor function imports (the @read /
;; @write markers in modules.imports).
;;
;; Note: NOT `shared` -- accessor closures don't require shared memory
;; because they go through JS-side memcpy, not WASM atomic ops.

(module
  (memory (export "memory") 1 4096)
  ;; Bake a known string at offset 256: "owner-payload-bytes" (19 bytes).
  (data (i32.const 256) "owner-payload-bytes"))

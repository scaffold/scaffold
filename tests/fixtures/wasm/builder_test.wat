;; Builder test: calls scaffold_builder.request_string for a key="name",
;; receives bytes back via packed (ptr, len), then returns the same
;; packed pointer as the result of build_params. The test supplies a
;; BuilderHost that returns "Joel" for "name" and asserts the contract
;; returned "Joel".

(module
  (import "scaffold_builder" "request_string"
    (func $request_string (param i32 i32 i32 i32) (result i64)))
  (memory (export "memory") 1 4096 shared)

  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "name" at offset 0, descriptor JSON at offset 16
  (data (i32.const 0)  "name")
  (data (i32.const 16) "{\"type\":\"string\",\"shortDescription\":\"Player name\"}")

  (func (export "build_params") (result i64)
    (call $request_string
      (i32.const 0) (i32.const 4)
      (i32.const 16) (i32.const 50))))

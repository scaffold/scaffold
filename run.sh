#!/bin/sh

exit 0

deno fmt --options-single-quote --watch
deno bundle --config=deno.json --import-map=import_map.json --watch pages/index.tsx build/index.js
deno run --allow-all --import-map=import_map.json --watch server/main.ts

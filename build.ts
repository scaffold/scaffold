import * as esbuild from 'https://deno.land/x/esbuild@v0.15.17/mod.js';
// import * as esbuild from 'https://deno.land/x/esbuild@v0.15.17/wasm.js';

import { denoPlugin } from 'https://deno.land/x/esbuild_deno_loader@0.6.0/mod.ts';

const result = await esbuild.build({
  plugins: [
    denoPlugin({
      importMapURL: new URL(`file:${import.meta.url}/import_map.json`),
    }),
  ],
  entryPoints: ['app.tsx'],
  outfile: './build.js',
  bundle: true,
  format: 'esm',
});

console.log(result.outputFiles);

esbuild.stop();

import { bundle } from 'https://deno.land/x/emit@0.33.0/mod.ts';
import denoJson from '../deno.json' with { type: 'json' };

const result = await bundle(
  new URL('./main.ts', import.meta.url),
  {
    allowRemote: true,
    compilerOptions: {
      checkJs: false,
    },
    importMap: {
      imports: denoJson.imports,
    },
    minify: false,
  },
);

await Deno.mkdir(new URL('./dist', import.meta.url), { recursive: true });
await Deno.writeTextFile(
  new URL('./dist/bundle.js', import.meta.url),
  result.code,
);

// deno-lint-ignore no-console
console.log('Built viz/dist/bundle.js');

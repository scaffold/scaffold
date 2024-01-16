import { bundle } from 'https://deno.land/x/emit@0.33.0/mod.ts';
import denoJson from './deno.json' with { type: 'json' };

const result = await bundle(
  new URL('./app.tsx', import.meta.url),
  {
    /** Allow remote modules to be loaded or read from the cache. */
    allowRemote: true,
    /** The cache root to use, overriding the default inferred `DENO_DIR`. */
    // cacheRoot: undefined,
    /** The setting to use when loading sources from the Deno cache. */
    // cacheSetting: undefined,
    /** Compiler options which can be set when bundling. */
    compilerOptions: {
      checkJs: true,
      /** Determines if reflection meta data is emitted for legacy decorators or
       * not.  Defaults to `false`. */
      // emitDecoratorMetadata: true,
      // importsNotUsedAsValues: 'remove',
      /** When set, instead of writing out a `.js.map` file to provide source maps,
       * the source map will be embedded the source map content in the `.js` files.
       *
       * Although this results in larger JS files, it can be convenient in some
       * scenarios. For example, you might want to debug JS files on a webserver
       * that doesn’t allow `.map` files to be served. */
      // inlineSourceMap: false,
      /** When set, the original content of the `.ts` file as an embedded string in
       * the source map (using the source map’s `sourcesContent` property).
       *
       * This is often useful in the same cases as `inlineSourceMap`. */
      // inlineSources: false,
      /** Controls how JSX constructs are emitted in JavaScript files. This only
       * affects output of JS files that started in `.jsx` or `.tsx` files. */
      // jsx: 'jsx',
      /** Changes the function called in `.js` files when compiling JSX Elements
       * using the classic JSX runtime. The most common change is to use `"h"` or
       * `"preact.h"`. */
      // jsxFactory: 'preact.h',
      /** Specify the JSX fragment factory function to use when targeting react JSX
       * emit with jsxFactory compiler option is specified, e.g. `Fragment`. */
      // jsxFragmentFactory: 'Fragment',
      /** Enables the generation of sourcemap files. */
      // sourceMap: false,
    },
    /** An [import-map](https://deno.land/manual/linking_to_external_code/import_maps#import-maps)
     * which will be applied to the imports, or the URL of an import map, or the
     * path to an import map */
    importMap: {
      /** Base URL to resolve import map specifiers. It Is always treated as a
       * directory. Defaults to the file URL of `Deno.cwd()`. */
      // baseUrl: undefined,
      /** Specifiers of the import map. */
      imports: denoJson.imports,
      /** Overrides of the specifiers for the provided scopes. */
      // scopes: undefined,
    },
    /** Override the default loading mechanism with a custom loader. This can
     * provide a way to use "in-memory" resources instead of fetching them
     * remotely. */
    // load: undefined,
    /** Minify compiled code, default false. */
    minify: true,
    /** Should the emitted bundle be an ES module or an IIFE script. The default
     * is `"module"` to output a ESM module. */
    // type: 'classic',
  },
);

await Deno.writeTextFile('./build/index.js', result.code);

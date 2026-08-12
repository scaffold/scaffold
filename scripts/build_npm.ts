// deno-lint-ignore-file no-console -- build script; its output is the UI.
import { build, emptyDir, EntryPoint } from '@deno/dnt';
import { parseArgs } from '@std/cli/parse-args';
import { error } from '../src/util/functional.ts';
import { expandGlob } from '@std/fs/expand-glob';
import { relative } from '@std/path/relative';
import * as esbuild from 'esbuild';

const flags = parseArgs(Deno.args, {
  string: ['version'],
  boolean: ['minify'],
  default: { minify: false },
});

const entryPoints: EntryPoint[] = [
  // The browser library. `./core` is the canonical name; `.` is kept as an
  // alias so `import { Scaffold } from 'scaffold.io'` keeps working alongside
  // `import { Scaffold } from 'scaffold.io/core'`.
  { kind: 'export', name: '.', path: './mod.ts' },
  // The pure, dependency-injected CLI -- importable from the browser as
  // `scaffold.io/cli`. The shell binary below injects a filesystem-backed
  // implementation of its deps.
  { kind: 'export', name: './cli', path: './src/cli/ScaffoldCLI.ts' },
  // `scaffold` on the user's PATH after `npm i -g scaffold.io` (or `npx`).
  { kind: 'bin', name: 'scaffold', path: './scripts/cli.ts' },
];

for await (
  const entry of expandGlob('./{src,plugins}/**/*.ts', {
    includeDirs: false,
    globstar: true,
    exclude: [
      './plugins/deno/**/*.ts',
      './src/contract/wasm/**/*.ts',
    ],
  })
) {
  let rel = relative('.', entry.path);
  if (rel.startsWith('src/')) rel = rel.slice(4);
  rel = rel.startsWith('.') ? rel : `./${rel}`;

  entryPoints.push({ kind: 'export', name: rel, path: entry.path });
}

console.log(`Building ${entryPoints.length} entry points...`);

await emptyDir('./npm');

await build({
  // `configFile`, not `importMap` -- the latter is read as a plain import map,
  // which doesn't expand bare specifiers to their sub paths (`@std/cli` would
  // not cover `@std/cli/parse-args`).
  configFile: './deno.json',
  entryPoints,
  outDir: './npm',
  compilerOptions: {
    lib: ['DOM', 'ESNext'],
    // `Latest` leaves `findLast`/`Object.hasOwn` un-polyfilled, which drops
    // `_dnt.polyfills.js` and its import from every emitted file -- and with it
    // the only import-time side effect in the package, so `sideEffects: false`
    // below is truthful.
    target: 'Latest',
  },
  shims: {
    // deno: true,
  },
  test: false,
  typeCheck: 'both',
  // ESM-only. dnt's `import.meta` ponyfill imports `node:module`, and every
  // emitted file imports the polyfill bundle -- which breaks any browser
  // bundler. The ponyfill can only be turned off when no CJS is emitted,
  // because `import.meta` isn't valid CommonJS.
  scriptModule: false,
  polyfills: {
    importMeta: false,
  },
  package: {
    name: 'scaffold.io',
    version: flags.version || error(`Please specify a version!`),
    description: 'Let your clients be your cloud',
    license: 'Apache-2.0',
    author: 'Joel Walker',
    // Only the runtime output ships. `npm/src` is dnt's intermediate TypeScript
    // and is build-time only. (npm always includes package.json, README and
    // LICENSE regardless; they are listed for clarity.)
    files: ['esm', 'README.md', 'LICENSE'],
    // No module in the package has an import-time side effect -- verified, and
    // kept true by the `Latest` target above dropping the polyfill import.
    sideEffects: false,
    // ESM-only, so Node has to be new enough for `require(esm)`.
    engines: {
      node: '>=22',
    },
    repository: {
      type: 'git',
      url: 'git+https://github.com/scaffold/scaffold.git',
    },
    bugs: {
      url: 'https://github.com/scaffold/scaffold/issues',
    },
    homepage: 'https://scaffold.io',
    // The bin entry (scripts/cli.ts) imports `node:*`, so the build needs
    // Node's types to check it.
    devDependencies: {
      '@types/node': '^22.10.2',
    },
  },

  async postBuild() {
    Deno.copyFileSync('README.md', 'npm/README.md');
    Deno.copyFileSync('LICENSE', 'npm/LICENSE');

    if (!flags.minify) return chmodBins();

    // Minify each emitted file in place. Deliberately not a bundle: the package
    // has 100+ export subpaths, and bundling per entry point would duplicate
    // every shared module into each one.
    const emitted: string[] = [];
    for await (
      const entry of expandGlob('./npm/esm/**/*.js', {
        includeDirs: false,
        globstar: true,
      })
    ) {
      emitted.push(entry.path);
    }

    const before = await dirSize('./npm/esm');
    await esbuild.build({
      entryPoints: emitted,
      outdir: './npm/esm',
      outbase: './npm/esm',
      allowOverwrite: true,
      format: 'esm',
      minify: true,
      // `BaseContext` reports `Type.name` in its diagnostics. Identifiers are
      // still renamed; this only keeps the `.name` metadata intact so those
      // messages don't come back as single letters.
      keepNames: false,
      logLevel: 'warning',
    });
    await esbuild.stop();

    const after = await dirSize('./npm/esm');
    console.log(
      `Minified ${emitted.length} files: ${fmtKb(before)} -> ${fmtKb(after)}`,
    );

    chmodBins();
  },
});

// dnt writes the shebang but leaves the bin at 0644. A registry install papers
// over it (npm chmods bin targets itself), but `file:`/`npm link` installs
// symlink straight into this tree, so the missing bit surfaces as EACCES.
function chmodBins() {
  const pkg = JSON.parse(Deno.readTextFileSync('npm/package.json'));
  for (const target of Object.values(pkg.bin ?? {}) as string[]) {
    Deno.chmodSync(`npm/${target}`, 0o755);
  }
}

async function dirSize(dir: string) {
  let total = 0;
  for await (const entry of expandGlob(`${dir}/**/*`, { includeDirs: false, globstar: true })) {
    total += (await Deno.stat(entry.path)).size;
  }
  return total;
}

function fmtKb(bytes: number) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

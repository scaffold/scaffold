// deno-lint-ignore-file no-console -- build script; its output is the UI.
import { build, emptyDir, EntryPoint } from '@deno/dnt';
import { parseArgs } from '@std/cli/parse-args';
import { error } from '../src/util/functional.ts';
import { expandGlob } from '@std/fs/expand-glob';
import { relative } from '@std/path/relative';

const flags = parseArgs(Deno.args, {
  string: ['version'],
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
  },
  shims: {
    // deno: true,
  },
  test: false,
  typeCheck: 'both',
  // scriptModule: false,
  package: {
    name: 'scaffold.io',
    version: flags.version || error(`Please specify a version!`),
    description: 'Let your clients be your cloud',
    // "main": "lib/index.js",
    // "bin": "bin/index.js",
    // "scripts": {
    //   "test": "echo \"Error: no test specified\" && exit 1"
    // },
    author: 'Joel Walker',
    repository: {
      type: 'git',
      url: 'git+https://github.com/SublimeNet/sublime.git',
    },
    bugs: {
      url: 'https://github.com/SublimeNet/sublime/issues',
    },
    homepage: 'https://github.com/SublimeNet/sublime#readme',
    // The bin entry (scripts/cli.ts) imports `node:*`, so the build needs
    // Node's types to check it.
    devDependencies: {
      '@types/node': '^22.10.2',
    },
  },

  postBuild() {
    // Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync('README.md', 'npm/README.md');
  },
});

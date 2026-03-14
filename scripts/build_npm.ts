import { build, emptyDir, EntryPoint } from '@deno/dnt';
import { parseArgs } from '@std/cli/parse-args';
import { error } from '../src/util/functional.ts';
import { walk } from '@std/fs/walk';
import { expandGlob } from '@std/fs/expand-glob';
import { relative } from '@std/path/relative';

const flags = parseArgs(Deno.args, {
  string: ['version'],
});

const entryPoints: EntryPoint[] = [
  { kind: 'export', name: '.', 'path': './mod.ts' },
];

for await (
  const entry of expandGlob('./{src,plugins}/**/*.ts', {
    includeDirs: false,
    globstar: true,
    exclude: [
      './plugins/deno/**/*.ts',
      './src/worker/**/*.ts',
      './src/contracts/**/*.ts',
      './src/util/QueueMuxer.ts',
    ],
  })
) {
  let rel = relative('.', entry.path);
  if (rel.startsWith('src/')) rel = rel.slice(4);
  rel = rel.startsWith('.') ? rel : `./${rel}`;

  entryPoints.push({ kind: 'export', name: rel, path: entry.path });
}

await emptyDir('./npm');

await build({
  importMap: 'deno.json',
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
  },

  postBuild() {
    // Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync('README.md', 'npm/README.md');
  },
});

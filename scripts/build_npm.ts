import { build, emptyDir } from 'dnt';
import { parseArgs } from '@std/cli/parse-args';
import { error } from '../src/util/functional.ts';

const flags = parseArgs(Deno.args, {
  string: ['version'],
});

await emptyDir('./npm');

await build({
  entryPoints: [
    './app.tsx',
    './server/main.ts',
  ],
  outDir: './npm',
  importMap: 'import_map.json',
  compilerOptions: {},
  shims: {
    // see JS docs for overview and more options
    // deno: true,
  },
  test: false,
  // typeCheck: "both",
  scriptModule: false,
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
});

// Deno.copyFileSync("LICENSE", "npm/LICENSE");
Deno.copyFileSync('README.md', 'npm/README.md');

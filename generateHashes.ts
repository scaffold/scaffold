import * as fs from 'std-latest/fs/mod.ts';
import * as path from 'std-latest/path/mod.ts';
import Hash from './sbl/util/Hash.ts';

const cppLines = [`#include <string_view>`, ``];
const tsLines = [`import Hash from '../sbl/util/Hash.ts';`, ``];

const bootstrapPath = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  'server',
  'bootstrap',
);
for await (const entry of fs.walk(bootstrapPath, { includeDirs: false })) {
  const body = await Deno.readFile(entry.path);
  const hash = Hash.digest(body);
  const name = entry.name.split('.')[0];

  cppLines.push(`constexpr std::string_view ${name}_hash = "${hash.toHex()}";`);
  tsLines.push(`export const ${name}_hash = Hash.fromHex("${hash.toHex()}");`);
}

await Deno.writeTextFile('cpp/hashes.h', cppLines.join('\n'));
await Deno.writeTextFile('ui/moduleHashes.ts', tsLines.join('\n'));

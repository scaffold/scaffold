import * as fs from '$std/fs/mod.ts';
import { MaybePromise } from '../src/util/MaybePromise.ts';

export const bootstrapFromGlobs = async (
  globs: (string | URL)[],
  emitData: (name: string, data: Uint8Array) => MaybePromise<void>,
) => {
  let count = 0;

  for (const glob of globs) {
    for await (const file of fs.expandGlob(glob, { includeDirs: false })) {
      const data = await Deno.readFile(file.path);
      await emitData(file.name, data);
      count++;
    }
  }

  return { count };
};

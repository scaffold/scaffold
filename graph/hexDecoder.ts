import * as accountMessages from './accountMessages.ts';
import * as collatzMessages from './collatzMessages.ts';
import * as epochMessages from './epochMessages.ts';
import * as thrustMessages from './thrustMessages.ts';
import * as timeMessages from './timeMessages.ts';
import * as voxelMessages from './voxelMessages.ts';
import { hex2bin } from '~/sbl/util/hex.ts';

const src = hex2bin(Deno.args[0]);

Object.entries({
  accountMessages,
  collatzMessages,
  epochMessages,
  thrustMessages,
  timeMessages,
  voxelMessages,
}).forEach(([namespace, messages]) =>
  Object.entries(messages).forEach(([msgName, coder]) => {
    try {
      console.log(namespace, coder.decode(src));
    } catch {
      console.log(namespace, msgName, `[error]`);
    }
  })
);

import * as fflate from 'https://cdn.skypack.dev/fflate?min';
import { str2bin } from './buffer.ts';

export const unzip = <ReturnType>(
  data: Uint8Array,
  handler: (key: Uint8Array[], data: Uint8Array) => ReturnType,
): ReturnType[] => {
  const unzipped = fflate.unzipSync(data) as Record<string, Uint8Array>;
  return Object.entries(unzipped).map(([path, contents]) =>
    handler(path.split('/').slice(1).map(str2bin), contents)
  );
};

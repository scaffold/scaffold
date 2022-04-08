import { walk } from 'std-latest/fs/mod.ts';

for await (const entry of walk('modules')) {
  if (entry.isFile && entry.name.slice(-3) === '.ts') {
    const worker = new Worker(new URL(entry.path, import.meta.url).href, {
      type: 'module',
      deno: {
        namespace: false,
        permissions: {
          env: false,
          hrtime: false,
          net: false,
          ffi: false,
          read: false,
          run: false,
          write: false,
        },
      },
    });

    worker.onmessage = (e) => {
      console.log(e.data);
    };

    worker.postMessage({ filename: './log.txt' });
    worker.postMessage({ close: {} });
  }
}

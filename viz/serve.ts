import { extname } from '@std/path';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const vizDir = new URL('.', import.meta.url);

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === '/') path = '/index.html';

  try {
    const filePath = new URL('.' + path, vizDir);
    const data = await Deno.readFile(filePath);
    const ext = extname(path);
    const contentType = MIME[ext] || 'application/octet-stream';
    return new Response(data, {
      headers: { 'content-type': contentType },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
});

// deno-lint-ignore no-console
console.log('Serving viz at http://localhost:8080');

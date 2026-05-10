import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const npmDeps = resolve(__dirname, '../npm/esm/deps');

/** Rewrite Deno URL imports (https://deno.land/...) to pre-compiled npm deps. */
function denoUrlRewriter(): Plugin {
  const urlMap: Record<string, string> = {
    'https://deno.land/std@0.160.0/hash/sha256.ts': resolve(
      npmDeps,
      'deno.land/std@0.160.0/hash/sha256.js',
    ),
    'https://deno.land/std@0.160.0/hash/sha3.ts': resolve(
      npmDeps,
      'deno.land/std@0.160.0/hash/sha3.js',
    ),
  };
  return {
    name: 'deno-url-rewriter',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') && !id.endsWith('.js')) return;
      let changed = false;
      let result = code;
      for (const [url, replacement] of Object.entries(urlMap)) {
        if (result.includes(url)) {
          result = result.replaceAll(url, replacement);
          changed = true;
        }
      }
      if (changed) return { code: result, map: null };
    },
  };
}

/**
 * Set Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy so the
 * demo runs cross-origin isolated. Required by SharedArrayBuffer (and thus
 * by the AtomicsWorkerTransport that the WASM contract runtime uses). See
 * docs/protocol/wasm-abi.md#async-bridge-transport.
 */
function crossOriginIsolation(): Plugin {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [crossOriginIsolation(), denoUrlRewriter(), react()],
  resolve: {
    alias: {
      '@scaffold/explorer': resolve(__dirname, '../explorer/src/index.ts'),
      // Resolve scaffold.io imports directly to Deno source for instant HMR.
      // Deno-specific deps (below) are mapped to the pre-compiled npm output.
      'scaffold.io': resolve(__dirname, '../src'),
      // JSR / Deno std deps -- map to dnt-compiled equivalents
      '@std/encoding': resolve(npmDeps, 'jsr.io/@std/encoding/1.0.7/mod.js'),
      '@std/assert/assert': resolve(npmDeps, 'jsr.io/@std/assert/1.0.11/assert.js'),
      '@std/assert': resolve(npmDeps, 'jsr.io/@std/assert/1.0.11/mod.js'),
      '@std/bytes': resolve(npmDeps, 'jsr.io/@std/bytes/1.0.5/mod.js'),
      '@std/random': resolve(npmDeps, 'jsr.io/@std/random/0.1.0/mod.js'),
      '@noble/secp256k1': resolve(npmDeps, 'jsr.io/@noble/secp256k1/2.2.3/index.js'),
    },
  },
});

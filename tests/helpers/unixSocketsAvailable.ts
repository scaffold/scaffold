// Sandboxed environments (e.g. restricted CI, Claude Code's default sandbox)
// deny binding unix domain sockets. Probe once at module load so tests that
// fundamentally require unix IPC can mark themselves `ignore` instead of
// failing with a misleading PermissionDenied error.

let cached: boolean | undefined;

export function unixSocketsAvailable(): boolean {
  if (cached !== undefined) return cached;
  const probePath = `${
    Deno.env.get('TMPDIR') ?? '/tmp/'
  }scaffold-unix-probe-${crypto.randomUUID()}.sock`;
  try {
    const listener = Deno.listen({ path: probePath, transport: 'unix' });
    listener.close();
    try {
      Deno.removeSync(probePath);
    } catch { /* already gone */ }
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

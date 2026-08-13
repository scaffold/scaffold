// Reads the ?fixture=1 query-string flag. Today this is informational only:
// without real compiler contracts (Workstream C), every language tab already
// uses the locally-published C0 echo `.wasm` regardless. When live compilers
// land, fixture mode will skip the network and force the echo path; the live
// (default) path will go to a remotely-published compiler hash.

export function isFixtureMode(): boolean {
  if (typeof globalThis === 'undefined' || !globalThis.location) return false;
  const params = new URLSearchParams(globalThis.location.search);
  const v = params.get('fixture');
  return v === '1' || v === 'true';
}

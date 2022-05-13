declare function open(contract: StaticArray<u8>, params: Uint8Array): u64;
declare function read(handle: u64): Uint8Array;

export function verify(publication: Uint8Array, hint: Uint8Array): bool {
  return true;
}

// TODO: Maybe hint can only be provided after verification resolves indeterminately?

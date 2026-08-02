export enum AtomType {
  Block = 0,
  Signal = 1,
  Request = 2,
}

// Deliberately outside the byte range AtomType occupies: these are in-memory node
// kinds, never wire type bytes, so one `type` field discriminates Block | BlockRef | Draft.
export const BLOCK_REF_TYPE = 256;
export const DRAFT_TYPE = 257;

export enum AtomSource {
  Genesis,
  Local,
  Remote,
  Storage,
}

import { Block } from './messages.ts';

export const defaultMeta = {
  isGenerator: false,
  isVerified: false,
};

export type BlockExt = Block & typeof defaultMeta;

import { RECORD_CONTRACT } from '../core/Block.ts';
import { Output, Verifier } from '../core/BlockCreationModule.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { str2bin } from '../util/buffer.ts';
import { Hash } from '../util/Hash.ts';
import { Primitive } from '../util/types.ts';

export interface PutClaim {
  /** The verifier to execute */
  contract: Hash;
  params: Uint8Array | Record<string, unknown>;

  /** Whether to skip executing the generator */
  skipGeneration?: boolean;
}

/** Request to put data into the network */
export interface PutRequest {
  claims?: PutClaim[];
  outputs?: Output[];
  records?: Record<string, Uint8Array | string>;

  /** You can "lock" funds for a future publication by providing a key with `publish: false` */
  key?: Primitive | Hash;

  publish?: boolean;
}

export class PutManager {
  constructor(private ctx: ProtocolContext) {}

  /** Create and submit a block from a put request. */
  put(request: PutRequest): Promise<void> {
    // Convert records into outputs
    if (request.records !== undefined) {
      request = {
        ...request,
        outputs: [
          ...request.outputs ?? [],
          ...Object.entries(request.records).map(([key, value]) => ({
            verifier: { contract: RECORD_CONTRACT, params: str2bin(key) },
            value: 0,
            data: typeof value === 'string' ? str2bin(value) : value,
          })),
        ],
      };
    }

    this.ctx.get(DraftManager).createDraft({});
  }
}

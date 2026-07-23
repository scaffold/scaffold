import { Hash } from '../util/Hash.ts';
import { Block, BlockStore } from '../core/Block.ts';
import type { Output, Verifier } from '../core/BlockCreationModule.ts';
import { bin2hex } from '../util/hex.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { BlockVerificationService } from '../core/BlockVerificationService.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import type { TrustGate, TrustStatus } from './TrustGate.ts';
import { type FieldNode, RecordingWalkerHost } from '../core/RecordingWalkerHost.ts';
import { bin2str } from '../util/buffer.ts';
import { findRecordOutput } from '../contracts/RecordContract.ts';
import { ScopedLogger } from '../core/EventLog.ts';
import type { SendHandle, SendRequest } from './SendManager.ts';
import {
  FetchAbortError,
  InvalidatedError,
  NotImplementedError,
  SupersededError,
  VerificationRejectedError,
} from './FetchErrors.ts';
import { Query } from '../interfaces/Query.ts';
import { NodeContext } from './NodeContext.ts';
import { Context } from '../Context.ts';

export interface FetchInput<T = unknown> {
  query: Query;
  signal?: AbortSignal;
  onResult?: (result: FetchResult<T> | null) => void;
}

export interface FetchResult<T = unknown> {
  readonly body: Uint8Array;
  parse(): Promise<T>;
}

export interface FetchHandle {
  close(): void;
}

export class FetchService {
  constructor(private ctx: Context) {}

  /** Public API: subscribe to a verifier with per-caller projection. */
  fetch<T = unknown>(input: FetchInput<T>): FetchHandle {
    if (!(input.query.params instanceof Uint8Array)) {
      throw new Error(`Reader-based params are not supported yet`);
    }
  }
}

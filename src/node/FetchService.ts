import { Query } from '../interfaces/Query.ts';
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

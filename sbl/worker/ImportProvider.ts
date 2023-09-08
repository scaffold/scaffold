import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { WorkerChannelClient } from '~/sbl/worker/WorkerChannel.ts';
import { JobMessage, WorkerComm } from '~/sbl/worker/workerTypes.ts';

export interface ImportSpec {
  contractHash: Hash;
  contractParams: Uint8Array;
  wrapperParams: Uint8Array;
}

// export default interface ImportProvider {
//   setup(
//     requestSuper: (spec: ImportSpec) => WebAssembly.Imports,
//   ): WebAssembly.Imports;

//   construct(memory: WebAssembly.Memory): void;
//   destruct(): void;
// }

type ImportProvider = (
  factory: ImportFactory,
  spec: ImportSpec,
) => Promise<WebAssembly.Imports>;

export default class ImportFactory {
  private providers = new Map<HashPrimitive, ImportProvider>();
  private defaultProvider: ImportProvider = () => {
    throw new Error(`No default import provider registered!`);
  };

  constructor(
    private client: WorkerChannelClient<WorkerComm>,
    private job: JobMessage,
  ) {}

  public registerImportProvider(contractHash: Hash, provider: ImportProvider) {
    this.providers.set(contractHash.toPrimitive(), provider);
  }
  public registerDefaultImportProvider(provider: ImportProvider) {
    this.defaultProvider = provider;
  }

  public getImports(spec: ImportSpec): Promise<WebAssembly.Imports> {
    const provider = this.providers.get(spec.contractHash.toPrimitive()) ??
      this.defaultProvider;
    return provider(this, spec);
  }

  public enqueueEntry(cb: (memory: WebAssembly.Memory) => void) {}

  public enqueueExit(cb: () => void) {}
}

interface Port<Message> {
  postMessage(msg: Message): void;
}

type Postable = number | bigint | string | Uint8Array;
export type ImportsBase = { [key: string]: (...args: Postable[]) => void };
export type ExportsBase = { [key: string]: (...args: Postable[]) => void };

export interface TransportMain<
  Imports extends ImportsBase,
  Exports extends ExportsBase,
  InitMsg,
> {
  registerImport<Name extends keyof Imports>(name: Name, fn: Imports[Name]): void;
  makeExport<Name extends keyof Exports>(name: Name): Exports[Name];

  makeInitMsg(): InitMsg;
}

export interface TransportWorker<
  Imports extends ImportsBase,
  Exports extends ExportsBase,
  ControlMsg,
> {
  makeImport<Name extends keyof Imports>(name: Name): Imports[Name];
  registerExport<Name extends keyof Exports>(name: Name, fn: Exports[Name]): void;

  recvMessage(msg: ControlMsg): void;
}

export interface Transport<
  Imports extends ImportsBase,
  Exports extends ExportsBase,
  InitMsg,
  ControlMsg,
> {
  createMain(worker: Port<ControlMsg>): TransportMain<Imports, Exports, InitMsg>;
  createWorker(init: InitMsg): TransportWorker<Imports, Exports, ControlMsg>;
}

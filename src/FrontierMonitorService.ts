import Context from './Context.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { Verifier } from './messages.ts';

export type MonitorCb = (block: BlockFact, outputIdx: number) => void;

export default class FrontierMonitorService {
  // private monitors;

  constructor(private ctx: Context) {}

  public monitorOutput(
    contractHash: Hash,
    params: Uint8Array,
    onEnter: MonitorCb,
    onExit: MonitorCb,
  ) {
    return { releaseMonitor: () => {} };
  }
}

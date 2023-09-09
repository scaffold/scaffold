import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { BlockSetFact } from '~/sbl/FactMeta.ts';
import { Verifier } from '~/sbl/messages.ts';

export type MonitorCb = (blockHash: Hash, outputIdx: number) => void;

export default class FrontierMonitorService {
  // private monitors;

  constructor(private ctx: Context) {}

  public monitorOutput(
    contractHash: Hash,
    paramsStartWith: Uint8Array,
    onEnter: MonitorCb,
    onExit: MonitorCb,
  ) {
    return { releaseMonitor: () => {} };
  }

  public replaceFrontierSet(oldSet?: BlockSetFact, newSet?: BlockSetFact) {
  }
}

import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import ThrustInitContract from './ThrustInitContract.ts';
import ThrustInputContract from './ThrustInputContract.ts';
import * as timeMessages from './timeMessages.ts';
import TimeContract from './TimeContract.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';
import SimplexNoise from 'simplex-noise';
import { getOrCreate } from '~/sbl/util/map.ts';

const noiseInstances: Map<string, SimplexNoise> = new Map();

export default class ThrustMazeContract {
  constructor(private ctx: Context) {}

  public get() {
    const thrustMazeGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      const { match, x, y } = thrustMessages.MazeParams.decode(params);
      const noise = getOrCreate(
        noiseInstances,
        match.toHex(),
        () => new SimplexNoise(match.toHex()),
      );

      const isWall = noise.noise2D(Number(x) / 10, Number(y) / 10) > 0;

      const cell = isWall ? { MazeCellWall: {} } : { MazeCellEmpty: {} };
      return thrustMessages.MazeAnswer.encode({ cell });
    };

    const thrustMazeContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        thrustMazeGenerator(contractHash, params, true, request, notify),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).thrustMazeGenerator = thrustMazeGenerator;
    (window as any).thrustMessages = thrustMessages;
    // (window as any).noiseInstances=noiseInstances;
    // (window as any).SimplexNoise=SimplexNoise;

    const contract = this.ctx.get(GraphUtils).supplyContract(
      thrustMazeContract,
    );
    this.ctx.get(GraphUtils).supplyGenerator(contract, thrustMazeGenerator);

    this.ctx.get(QaDebugger).addDebugger(
      'ThrustMazeContract',
      contract.hash,
      (params) => thrustMessages.MazeParams.decode(params),
      (answer) => thrustMessages.MazeAnswer.decode(answer),
    );

    return contract;
  }
}

import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import ThrustInputProvider from './ThrustInputProvider.tsx';
import * as thrustMessages from '../ts/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';
import {
  thrust_game_wasm_hash,
  thrust_maze_wasm_hash,
} from './moduleHashes.ts';
import FetchService from '../sbl/FetchService.ts';

// Must match the tickInterval in generator
const msPerTick = 100;

export default class ThrustProvider {
  private curInputEntry: thrustMessages.InputEntry = {
    pressing_fwd: false,
    pressing_bwd: false,
    pressing_left: false,
    pressing_right: false,
    pressing_fire: false,
  };

  private latestStateIdx = 0n;
  private latestStateTime = 0;
  private latestStateVal: thrustMessages.GameAnswer = {
    game_state: {
      center: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 0,
    },
    players: [],
    bullets: [],
  };

  private tracker: { release(): void };

  constructor(private ctx: Context, public match: Hash, public player: Hash) {
    this.tracker = ctx.get(StateTracker).track(
      (idx) => ({
        contract_hash: thrust_game_wasm_hash,
        params: thrustMessages.GameParams.encode({ match, tick: idx }),
      }),
      (idx, state) => {
        console.log('STATE', state);
        if (idx > this.latestStateIdx) {
          this.latestStateIdx = idx;
          this.latestStateTime = Date.now();
          this.latestStateVal = thrustMessages.GameAnswer.decode(state.body);
          console.log('got', idx, this.latestStateVal);
        }
      },
      {
        // initIdx: 0n,
        // futureSubCount: 100n,
        // narrowingSubCount: 16n,
        // unsubWaitMs: 10000,
        // maxSubLog2: 63n,

        initIdx: 0n,
        futureSubCount: 4n,
        narrowingSubCount: 16n,
        unsubWaitMs: 1000,
        maxSubLog2: 8n,
      },
    );

    ctx.get(ThrustInputProvider).setInputCallback(
      match,
      player,
      (_tick) => this.curInputEntry,
    );
  }

  public destruct() {
    this.ctx.get(ThrustInputProvider).setInputCallback(this.match, this.player);
    this.tracker.release();
  }

  public getCell(x: bigint, y: bigint) {
    let hasResolved = false;

    return new Promise<thrustMessages.MazeAnswer['cell']>((resolve) =>
      this.ctx.get(FetchService).fetch(
        {
          contract_hash: thrust_maze_wasm_hash,
          params: thrustMessages.MazeParams.encode({ match: this.match, x, y }),
        },
        { internalIncentive: 20n },
        (block) => {
          if (hasResolved) {
            // This is fine; as long as the data doesn't change
            // throw new Error(`Cell resolved more than once!`);
            return;
          }
          hasResolved = true;
          resolve(thrustMessages.MazeAnswer.decode(block.body).cell);
        },
      )
    );
  }

  public getRenderIdx() {
    return this.latestStateIdx;
  }

  public getRenderState(): thrustMessages.GameAnswer {
    const ot = (Date.now() - this.latestStateTime) / msPerTick;
    return {
      ...this.latestStateVal,
      players: this.latestStateVal.players.map((player) => ({
        ...player,
        position: {
          x: player.position.x + player.velocity.x * ot,
          y: player.position.y + player.velocity.y * ot,
        },
      })),
    };
  }

  public setFwd(value: boolean) {
    this.curInputEntry.pressing_fwd = value;
  }
  public setBwd(value: boolean) {
    this.curInputEntry.pressing_bwd = value;
  }
  public setLeft(value: boolean) {
    this.curInputEntry.pressing_left = value;
  }
  public setRight(value: boolean) {
    this.curInputEntry.pressing_right = value;
  }
  public setFire(value: boolean) {
    this.curInputEntry.pressing_fire = value;
  }
}

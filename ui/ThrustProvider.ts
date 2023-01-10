import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import ThrustMazeContract from '~/graph/ThrustMazeContract.ts';
import ThrustInputContract from '~/graph/ThrustInputContract.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';
import IncentiveService from '../sbl/IncentiveService.ts';
import { BlocksByVerifierStore } from '../sbl/stores.ts';
import StoreObserver from '../sbl/util/StoreObserver.ts';
import { Verifier } from '../sbl/messages.ts';

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
    const contractHash = ctx.get(ThrustGameContract).get();

    this.tracker = ctx.get(StateTracker).track(
      (idx) => ({
        contract_hash: contractHash,
        params: thrustMessages.GameParams.encode({
          match,
          tick: idx,
        }),
      }),
      (idx, state) => {
        console.log('STATE', state);
        if (idx > this.latestStateIdx) {
          this.latestStateIdx = idx;
          this.latestStateTime = Date.now();
          this.latestStateVal = thrustMessages.GameAnswer.decode(
            new Uint8Array([]),
          );
          console.log('got', idx);
        }
      },
      {
        initIdx: 0n,
        futureSubCount: 100n,
        narrowingSubCount: 16n,
        unsubWaitMs: 10000,
      },
    );

    ctx.get(ThrustInputContract).setInputCallback(
      match,
      player,
      (_tick) => this.curInputEntry,
    );
  }

  public destruct() {
    this.ctx.get(ThrustInputContract).setInputCallback(this.match, this.player);
    this.tracker.release();
  }

  public getCell(x: bigint, y: bigint) {
    let hasResolved = false;

    return new Promise<thrustMessages.MazeAnswer['cell']>((resolve) => {
      const verifier = {
        contract_hash: this.ctx.get(ThrustMazeContract).get(),
        params: thrustMessages.MazeParams.encode({ match: this.match, x, y }),
      };
      this.ctx.get(IncentiveService).incentivize(verifier, 1000000n);

      StoreObserver.get(this.ctx.get(BlocksByVerifierStore)).observe(
        Hash.digest(Verifier.encode(verifier)),
        (blocks) => {
          console.log('GOT', x, y);
          if (hasResolved) {
            throw new Error(`Cell resolved more than once!`);
          }
          if (!blocks) {
            throw new Error(`Blocks is undefined!`);
          }
          if (blocks.length !== 1) {
            throw new Error(`Not exactly one block!`);
          }
          hasResolved = true;
          resolve(thrustMessages.MazeAnswer.decode(blocks[0].body).cell);
        },
      );
    });
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

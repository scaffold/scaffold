import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';
import ThrustMazeContract from '~/graph/ThrustMazeContract.ts';
import ThrustInputContract from '~/graph/ThrustInputContract.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';

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
      size: 1000,
    },
    players: [],
    bullets: [],
  };

  private tracker: { release(): void };

  constructor(private ctx: Context, public match: Hash, public player: Hash) {
    const contractHash = ctx.get(ThrustGameContract).get().hash;

    this.tracker = ctx.get(StateTracker).track(
      (idx) => ({
        contract_answer_hash: contractHash,
        params: thrustMessages.GameParams.encode({
          match,
          tick: idx,
        }),
      }),
      (idx, state) => {
        if (idx > this.latestStateIdx) {
          this.latestStateIdx = idx;
          this.latestStateTime = Date.now();
          this.latestStateVal = thrustMessages.GameAnswer.decode(state.data);
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
      const questionSub = this.ctx.get(QuestionService).getCanonical({
        contract_answer_hash: this.ctx.get(ThrustMazeContract).get().hash,
        params: thrustMessages.MazeParams.encode({ match: this.match, x, y }),
      });
      questionSub.incentivize(100000n);
      questionSub.onAnswer((answer) => {
        if (hasResolved) {
          throw new Error(`Cell resolved more than once!`);
        }
        hasResolved = true;
        resolve(thrustMessages.MazeAnswer.decode(answer.data).cell);
      });
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

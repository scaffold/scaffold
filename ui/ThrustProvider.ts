import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';

export default class ThrustProvider {
  private curInputEntry: thrustMessages.InputEntry = {
    pressing_fwd: false,
    pressing_bwd: false,
    pressing_left: false,
    pressing_right: false,
    pressing_fire: false,
  };

  private latestStateIdx = 0n;
  private latestStateVal: thrustMessages.GameAnswer = {
    game_state: {
      center: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 1000,
    },
    players: [],
    bullets: [],
  };

  constructor(ctx: Context, match: Hash) {
    const contractHash = ctx.get(ThrustGameContract).get().hash;

    const tracker = ctx.get(StateTracker).track(
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
          this.latestStateVal = thrustMessages.GameAnswer.decode(state.data);
        }
      },
      {
        initIdx: 0n,
        futureSubCount: 100n,
        narrowingSubCount: 16n,
        unsubWaitMs: 10000,
      },
    );

    this.destruct = tracker.release;
  }

  public destruct: () => void;

  public getRenderState() {
    return this.latestStateVal;
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

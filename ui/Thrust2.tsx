import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';

export default ({ sbl, match }: { sbl: Context; match: Hash }) => {
  const [state, setState] = React.useState<
    { time: bigint; gameState: thrustMessages.GameAnswer }
  >();
  console.log(state);

  React.useEffect(() => {
    const contractHash = sbl.get(ThrustGameContract).get().hash;

    const tracker = sbl.get(StateTracker).track(
      (idx) => ({
        contract_answer_hash: contractHash,
        params: thrustMessages.GameParams.encode({
          match,
          time: idx,
        }),
      }),
      (idx, state) =>
        setState({
          time: idx,
          gameState: thrustMessages.GameAnswer.decode(state.data),
        }),
      {
        initIdx: 0n,
        futureSubCount: 100n,
        narrowingSubCount: 16n,
        unsubWaitMs: 10000,
      },
    );

    return () => tracker.release();
  }, []);

  return (
    <div>
      <ul>
        <li>
          Match: <strong>{match.toHex()}</strong>
        </li>
      </ul>
    </div>
  );
};

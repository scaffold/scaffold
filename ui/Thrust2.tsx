import React from 'react';
import SblClient from './SblClient.ts';
import Hash from '~/sbl/util/Hash.ts';
import Context from '~/sbl/Context.ts';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import StateTracker from '~/sbl/StateTracker.ts';
import Logger from '~/sbl/Logger.ts';
import ThrustView from './ThrustView.tsx';

export default ({ sbl, match }: { sbl: Context; match: Hash }) => {
  const [state, setState] = React.useState<
    { tick: bigint; gameState: thrustMessages.GameAnswer }
  >();

  React.useEffect(() => {
    const match = sbl.get(ThrustInitContract).startGame(Hash.digest('abc'));

    const contractHash = sbl.get(ThrustGameContract).get();

    const tracker = sbl.get(StateTracker).track(
      (idx) => ({
        contract_hash: contractHash,
        params: thrustMessages.GameParams.encode({
          match,
          tick: idx,
        }),
      }),
      (idx, state) =>
        setState({
          tick: idx,
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

  if (!state) {
    return <div>No state</div>;
  }

  return (
    <div>
      <ul>
        <li>
          Match: <strong>{match.toHex()}</strong>
        </li>
        <li>
          Tick: <strong>{Number(state.tick)}</strong>
        </li>
        <li>
          Game state: <pre>
            {sbl.get(Logger).serialize(state.gameState)}
          </pre>
        </li>
      </ul>
      <ThrustView sbl={sbl} match={match} state={state.gameState} />
    </div>
  );
};

import React from 'react';
import SblClient from './SblClient.ts';
import Hash from '~/sbl/util/Hash.ts';
// import BlockService from '~/sbl/BlockService.ts';
import IncentiveService from '~/sbl/IncentiveService.ts';
import CollatzContract from '../graph/CollatzContract.ts';
// import ThrustView from './ThrustView.tsx';
// import ThrustInitContract from '~/graph/ThrustInitContract.ts';

const client = new SblClient();
const player = Hash.digest(client.ctx.config.selfPrivateKey);

export default () => {
  const [url, setUrl] = React.useState(new URL(window.location.href));
  const gameHex = url.searchParams.get('game');

  return (
    <div>
      <a
        href='#'
        onClick={() => {
          // const newUrl = new URL(url);
          // newUrl.searchParams.set(
          //   'game',
          //   client.ctx.get(ThrustInitContract).startGame(Hash.random()).toHex(),
          // );
          // window.history.pushState({}, '', newUrl);
          // setUrl(newUrl);
        }}
      >
        New Game
      </a>
      <br />
      <a
        href='#'
        onClick={() => {
          const verifier = {
            contract_hash: client.ctx.get(CollatzContract).get(),
            params: client.ctx.get(CollatzContract).makeParams(10n),
          };
          client.ctx.get(IncentiveService).incentivize(verifier, 10n);
        }}
      >
        Collatz depth of 10
      </a>

      {gameHex && (
        <>
          Game ID: <pre style={{ display: 'inline' }}>{gameHex}</pre>
          {
            /*
            <ThrustView
              sbl={client.ctx}
              match={Hash.fromHex(gameHex)}
              player={player}
            />
            */
          }
        </>
      )}
    </div>
  );
};

import React from 'react';
import SblClient from './SblClient.ts';
import Hash from '~/sbl/util/Hash.ts';
import BlockService from '../sbl/BlockService.ts';
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
          client.ctx.get(BlockService).ingest({
            claims: [],
            incentives: [],
            verifier: {
              contract_hash: Hash.random(),
              params: new Uint8Array(),
            },
            body: new Uint8Array(),
            timestamp: 123n,
          });
        }}
      >
        Ingest block
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

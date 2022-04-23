import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustView from './ThrustView.tsx';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';

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
          const newUrl = new URL(url);
          newUrl.searchParams.set(
            'game',
            client.ctx.get(ThrustInitContract).startGame(Hash.random()).toHex(),
          );
          window.history.pushState({}, '', newUrl);
          setUrl(newUrl);
        }}
      >
        New Game
      </a>
      <br />

      {gameHex && (
        <>
          Game ID: <pre style={{ display: 'inline' }}>{gameHex}</pre>
          <ThrustView
            sbl={client.ctx}
            match={Hash.fromHex(gameHex)}
            player={player}
          />
        </>
      )}
    </div>
  );
};

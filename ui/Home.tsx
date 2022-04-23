import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustView from './ThrustView.tsx';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';

const client = new SblClient();

const params = new URLSearchParams(window.location.search);
const urlGameHex = params.get('game');
const game = urlGameHex
  ? Hash.fromHex(urlGameHex)
  : client.ctx.get(ThrustInitContract).startGame(Hash.random());
const player = Hash.digest(client.ctx.config.selfPrivateKey);

export default () => {
  return (
    <div>
      Game ID:{' '}
      <a href={`${window.location.pathname}?game=${game.toHex()}`}>
        <pre style={{ display: 'inline' }}>{game.toHex()}</pre>
      </a>
      <br />
      <a href={window.location.pathname}>New Game</a>
      {/* <ThrustView sbl={client.ctx} match={game} player={player} /> */}
    </div>
  );
};

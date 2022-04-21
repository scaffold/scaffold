import { prettyBytes } from 'std-latest/fmt/bytes.ts';
import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import ThrustView from './ThrustView.tsx';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';

const client = new SblClient();

const match = client.ctx.get(ThrustInitContract).startGame(Hash.digest('abc'));
const player = Hash.digest('plyr1');

export default () => {
  const [contractName, setContractName] = React.useState('');
  const [contractParams, setContractParams] = React.useState('');
  const [answers, addAnswer] = React.useReducer(
    (
      priorAnswers: Answer[],
      newAnswer: Answer,
    ) => [...priorAnswers, newAnswer],
    [],
  );

  return (
    <div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const contractHash = await Hash.digest(contractName);
          client.ctx.get(QuestionService).getCanonical({
            contract_answer_hash: contractHash,
            params: new TextEncoder().encode(contractParams),
          }, addAnswer);
        }}
      >
        <label>
          Contract name:
          <input
            type='text'
            value={contractName}
            onChange={(e) => setContractName(e.currentTarget.value)}
          />
        </label>
        <br />
        <label>
          Contract params:
          <input
            type='text'
            value={contractParams}
            onChange={(e) => setContractParams(e.currentTarget.value)}
          />
        </label>
        <br />
        <input type='submit' value='Submit' />
      </form>
      <ul>
        {answers.map((answer) => (
          <pre>
            {prettyBytes(answer.data.byteLength, { binary: true })}
            {': '}
            {new TextDecoder().decode(answer.data)}
          </pre>
        ))}
      </ul>
      <ThrustView sbl={client.ctx} match={match} player={player} />
    </div>
  );
};

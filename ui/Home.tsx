import { prettyBytes } from 'std-latest/fmt/bytes.ts';
import React from 'react';
import SblClient from './SblClient.ts';
import { Answer } from '~/sbl/QuestionService.ts';
import Hash from '~/sbl/util/Hash.ts';

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
  const [client, setClient] = React.useState<SblClient>();

  React.useEffect(() => {
    const client = new SblClient();
    setClient(client);
    return () => client.close();
  }, []);

  React.useEffect(() => {
    const idx = setInterval(() => {}, 100);
    return () => clearInterval(idx);
  }, []);

  return (
    <div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const contractHash = await Hash.digest(contractName);
          client?.get(
            contractHash,
            new TextEncoder().encode(contractParams),
            addAnswer,
          );
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
    </div>
  );
};

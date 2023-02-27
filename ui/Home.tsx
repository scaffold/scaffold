import React from 'react';
import SblClient from './SblClient.ts';
import Hash from '~/sbl/util/Hash.ts';
// import BlockService from '~/sbl/BlockService.ts';
import IncentiveService from '~/sbl/IncentiveService.ts';
import { IncentiveRegistry } from '../sbl/registries.ts';
import BlockTableView from './BlockTableView.tsx';
import AccountService from '../sbl/AccountService.ts';
import Store2 from '../sbl/util/Store2.ts';
import StoreView from './StoreView.tsx';
import StoreSelector from './StoreSelector.tsx';
import Context from '../sbl/Context.ts';
import StoreObserver from '../sbl/util/StoreObserver.ts';
import { Verifier } from '../sbl/messages.ts';
import Logger from '../sbl/Logger.ts';
import ThrustView from './ThrustView.tsx';
import * as moduleHashes from './moduleHashes.ts';
import * as constants from '../sbl/constants.ts';
import { bin2str, decodeMultibase, str2bin } from '../sbl/pathUtils.ts';
import FetchService from '../sbl/FetchService.ts';
import LocalGeneratorService from '../sbl/LocalGeneratorService.ts';
import * as thrustMessages from '../ts/thrustMessages.ts';
import BlockService from '../sbl/BlockService.ts';
import BlockBuilder from '../sbl/BlockBuilder.ts';
import helloGenerator from '../ts/hello.generator.0.ts';
import thrustGameGenerator from '../ts/thrust_game.generator.0.ts';
import thrustMazeGenerator from '../ts/thrust_maze.generator.0.ts';
import TableView from './TableView.tsx';
import QaDebugger from '../sbl/QaDebugger.ts';

// QJS
// const initialContractHex =
//   '2699c934e05e42c7937c17bfa8d0f70cb8b65f47a5330e512df5f3b621a99709';
// const initialParams =
//   `qjs /ext/:f53424c00000000000000000000000000000000000000000000000000726f6f74/:fea2d95c07417afcedd35a10a3308361949261518b0518e2d98af1fce61b3464b.js`;

// Python
// const initialContractHex =
//   'cacf09f92d88a091f3729059f389bc0ec59d82c4b2be83ab7d08ad3849d4a9cc';
// const initialParams =
//   `python /ext/:f53424c00000000000000000000000000000000000000000000000000726f6f74/:f9e7cf4f3dfd247d2fb32f150195cf10433cf8b9bd17e2c1b18eccaa41a38b3ef.py`;

// Hello
const initialContractHex =
  '0f82ceb6b057bbe5d9e66003c4b725c97c56e804764f3538d9251d4d80c6eb20';
const initialParams = 'joel';

const contractHashes = Object.entries({ ...constants, ...moduleHashes });

const client = new SblClient();
const player = Hash.digest(client.ctx.config.selfPrivateKey);

// If we comment either of these out, the server should pick up the slack
client.ctx.get(LocalGeneratorService).addGenerator(
  moduleHashes.hello_wasm_hash,
  helloGenerator,
);
client.ctx.get(LocalGeneratorService).addGenerator(
  moduleHashes.thrust_game_wasm_hash,
  thrustGameGenerator,
);
client.ctx.get(LocalGeneratorService).addGenerator(
  moduleHashes.thrust_maze_wasm_hash,
  thrustMazeGenerator,
);

client.ctx.get(QaDebugger).addDebugger(
  'ThrustInit',
  moduleHashes.thrust_init_wasm_hash,
  (params) => thrustMessages.InitParams.decode(params),
  (answer) => thrustMessages.InitAnswer.decode(answer),
);
client.ctx.get(QaDebugger).addDebugger(
  'ThrustInput',
  moduleHashes.thrust_input_wasm_hash,
  (params) => thrustMessages.InputParams.decode(params),
  (answer) => thrustMessages.InputAnswer.decode(answer),
);
client.ctx.get(QaDebugger).addDebugger(
  'ThrustGame',
  moduleHashes.thrust_game_wasm_hash,
  (params) => thrustMessages.GameParams.decode(params),
  (answer) => thrustMessages.GameAnswer.decode(answer),
);
client.ctx.get(QaDebugger).addDebugger(
  'ThrustMaze',
  moduleHashes.thrust_maze_wasm_hash,
  (params) => thrustMessages.MazeParams.decode(params),
  (answer) => thrustMessages.MazeAnswer.decode(answer),
);

const startGame = () => {
  const body = thrustMessages.InitAnswer.encode({
    nonce: Hash.random(),
    init_time: BigInt(Date.now()),
  });
  const match = Hash.digest(body);
  const verifier = {
    contract_hash: moduleHashes.thrust_init_wasm_hash,
    params: match.toBytes(),
  };
  const block = client.ctx.get(BlockBuilder).build(verifier, body);
  client.ctx.get(BlockService).ingest(block);
  return match;
};

export default () => {
  const [url, setUrl] = React.useState(new URL(window.location.href));
  const [selectedContract, selectContract] = React.useState<string>(
    initialContractHex,
  );
  const [params, setParams] = React.useState<string>(initialParams);
  const gameHex = url.searchParams.get('game');

  const [shownStore, setShownStore] = React.useState<
    { key: number; clz?: { new (context: Context): Store2<any> } }
  >({ key: 0 });

  const [tableVersions, incTableVersion] = React.useReducer((x) => x + 1, 0);

  const gameHash = React.useMemo(() => gameHex && Hash.fromHex(gameHex), [
    gameHex,
  ]);

  return (
    <div>
      <a
        href='#'
        onClick={() => {
          const newUrl = new URL(url);
          newUrl.searchParams.set('game', startGame().toHex());
          window.history.pushState({}, '', newUrl);
          setUrl(newUrl);
        }}
      >
        New Game
      </a>

      <br />
      <select
        value={selectedContract}
        onChange={(e) => selectContract(e.target.value)}
      >
        {contractHashes.map(([name, hash]) => (
          <option value={hash.toHex()}>{name} ({hash.toHex()})</option>
        ))}
      </select>
      <input
        type='text'
        value={params}
        onChange={(e) => setParams(e.target.value)}
      />
      <button
        onClick={() =>
          client.ctx.get(FetchService).fetch(
            {
              contract_hash: Hash.fromHex(selectedContract!),
              params: str2bin(params),
            },
            // TODO: Why isn't this being picked up on the work queue?
            // It's because there's no generators registered.
            // Need to make a generatorHash and register them.
            // Does the same WASM act as both a generator and a contract?
            { internalIncentive: 1n, externalIncentive: 1n },
            (block) => console.log(bin2str(block.body), block),
          )}
      >
        RUN
      </button>

      <br />
      {
        /*
        <a href='#' onClick={() => client.ctx.get(AccountService)}>
          Start account loop
        </a>
        */
      }
      <StoreSelector
        ctx={client.ctx}
        onSelectClass={(clz) => setShownStore({ key: Math.random(), clz })}
      />

      {/*<BlockTableView ctx={client.ctx} />*/}
      {shownStore.clz && (
        <StoreView
          key={shownStore.key}
          ctx={client.ctx}
          Table={shownStore.clz}
        />
      )}

      <TableView name='BlockService' ctx={client.ctx} Table={BlockService} />
      {/*<TableView name='WorkQueue' ctx={client.ctx} Table={WorkQueue} />*/}
      <button onClick={incTableVersion}>Refresh</button>

      {gameHash && (
        <>
          Game ID: <pre style={{ display: 'inline' }}>{gameHex}</pre>
          {
            <ThrustView
              sbl={client.ctx}
              match={gameHash}
              player={player}
            />
          }
        </>
      )}
    </div>
  );
};

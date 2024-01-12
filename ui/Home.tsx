import React from 'react';
import SblClient from './SblClient.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import BlockTableView from './BlockTableView.tsx';
import ThrustView from './ThrustView.tsx';
import * as moduleHashes from './moduleHashes.ts';
import * as constants from '../sbl/constants.ts';
import { bin2str, str2bin } from '../sbl/util/buffer.ts';
import FetchService from '../sbl/FetchService.ts';
import LocalGeneratorService from '../sbl/LocalGeneratorService.ts';
import * as thrustMessages from '../ts/thrustMessages.ts';
import BlockBuilder from '../sbl/BlockBuilder.ts';
import helloGenerator from '../ts/hello.generator.0.ts';
import thrustGameGenerator from '../ts/thrust_game.generator.0.ts';
import thrustMazeGenerator from '../ts/thrust_maze.generator.0.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import Input from './Input.tsx';
import LitigationService from '~/sbl/LitigationService.ts';
import GenesisService, { sharedGenesisData } from '~/sbl/GenesisService.ts';
import FactView from '~/ui/FactView.tsx';
import CodeView from '~/ui/CodeView.tsx';
import FrontierService2 from '~/sbl/FrontierService2.ts';
import { defaultNetwork } from '~/sbl/Config.ts';
import SplashHeader from '~/ui/sections/SplashHeader.tsx';
import CodeExample from '~/ui/sections/CodeExample.tsx';
import Nope from '~/ui/sections/Nope.tsx';
import FeatureCard from '~/ui/sections/FeatureCard.tsx';
import observationMonitor from '~/ui/observationMonitor.ts';
import ScaffoldLogo from '~/ui/ScaffoldLogo.tsx';

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

client.ctx.get(GenesisService).ingestGenesis(sharedGenesisData);

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
  client.ctx.get(BlockBuilder).publish({ body, satisfies: [verifier] });
  return match;
};

export default () => {
  const [url, setUrl] = React.useState(new URL(window.location.href));
  const [network, setNetwork] = React.useState<string>(
    url.searchParams.get('network') ?? defaultNetwork,
  );
  const [selectedContract, selectContract] = React.useState<string>(
    initialContractHex,
  );
  const [params, setParams] = React.useState<string>(initialParams);
  const [body, setBody] = React.useState<string>('');
  const gameHex = url.searchParams.get('game');

  const [selectedHash, setSelectedHash] = React.useState<HashPrimitive>();
  const [hoveredHash, setHoveredHash] = React.useState<HashPrimitive>();

  const gameHash = React.useMemo(() => gameHex && Hash.fromHex(gameHex), [
    gameHex,
  ]);

  return (
    <>
      <div
        style={{
          height: '4rem',
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'row',
          backgroundColor: '#111',
          gap: '2rem',
          padding: '0.5rem',
        }}
      >
        {
          /*
          <a href='/'>
            <img
              src='/scaffold_logo_horizontal_white.png'
              style={{ display: 'block', height: '100%' }}
            />
          </a>
          */
        }
        <a href='/'>
          <ScaffoldLogo
            style={{ display: 'block', height: '100%' }}
            color='#8CB3F2'
          />
        </a>

        <div style={{ flex: '1' }}></div>

        <a href='/explorer' className='header-link'>Explorer</a>
        <a href='/docs' className='header-link'>Docs</a>
        <a href='/community' className='header-link'>Community</a>
        <a href='/blog' className='header-link'>Blog</a>

        <div></div>

        {/*Balance: ${Number(ctx.get(BalanceService).getLiquidBalance())}*/}
      </div>
      <br />

      <SplashHeader />
      <CodeExample />
      <Nope />

      <FeatureCard
        title='Fast. Very fast. Period.'
        desc="From the beginning Scaffold's #1 design goal has been speed and simplicity. We don't compromise on this."
      />

      <FeatureCard
        title='Cheap'
        desc='Stop spending $$$ to serve the same data to everyone. Let your users be your cloud.'
      />

      <FeatureCard
        title='Hackable'
        desc='The whole site is defined by a hash. Edit any of the sources to generate a new website.'
      />

      <FeatureCard
        title='This site runs on Scaffold'
        desc='The whole site is defined by a hash. Edit any of the sources to generate a new website.'
      />

      <FeatureCard
        title='Versatile'
        desc='Sharing static content P2P is just the tip of the iceberg; Scaffold does this without breaking a sweat.'
      />

      <FeatureCard
        title='Scalable'
        desc='Your users connect to the entire Scaffold network.'
      />

      <FeatureCard
        title='Embrace the web'
        desc='WebRTC | WebSockets | WebAssembly'
      />

      <FeatureCard
        title='How does it work?'
        desc='Scaffold is a global block-graph that incentivizes speed and correctness.'
      />

      <FeatureCard
        title='Is this a cryptocurrency?'
        desc={`Yes. However,
    (1) we believe it is necessary - to perform computations (not just returning static content) on non-trusted platforms (browsers), you have to incentivize correct answers and disincentivize incorrect answers. This requires some kind of transferrable store of value.
    (2) we believe it may be the first time using a cryptocurrency IS necessary. Many (if not all) of existing cryptocurrencies were created to achieve distributed consensus (usually to enable the creation of a token), at the cost of speed and throughput. We do the opposite - we prioritize speed first and consensus second. Large transactions will be finalized much more slowly, but this isn't a problem because we're using extremely small transactions to incentivize computation.`}
      />

      <div style={{ width: '100%' }}>
        <div style={{ backgroundColor: 'white', padding: '1rem' }}>
          <div style={{ backgroundColor: '#15079C' }}>
            Navy Blue Clarity, Possibility, Speed, #15079C
          </div>
          <div style={{ backgroundColor: '#8CB3F2' }}>
            Sky Blue Pioneer, Leader, Creative, #8CB3F2
          </div>
          <div style={{ backgroundColor: '#EEF0AD' }}>
            Pale Yellow Collaborator, Bridge, Developer, #EEF0AD
          </div>
          <div style={{ backgroundColor: '#D12D0E' }}>
            Burnt Orange Trust, Foundation, Expert, #D12D0E
          </div>
          <div style={{ backgroundColor: '#372733' }}>
            #372733
          </div>
        </div>

        The Onyx Programming Language A data-oriented, expressive, and modern
        programming language

        $ # Install Onyx in one command $ # Read the docs $ curl
        onyxlang.io/docs $ # Try Onyx in your browser $ curl try.onyxlang.io

        <Input label='Network' value={network} setValue={setNetwork} />
        <button
          onClick={() => {
            const newUrl = new URL(url);
            newUrl.searchParams.set('network', network);
            window.location.href = newUrl.toString();
          }}
        >
          Go
        </button>
        <br />

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

        <button
          onClick={() => {
            client.ctx.get(BlockBuilder).publish({});
          }}
        >
          Publish empty block
        </button>
        <button
          onClick={() => {
            client.ctx.get(BlockBuilder).publish({
              body: str2bin('abc'),
              satisfies: [{
                contract_hash: constants.rootHash,
                params: Hash.digest('abc').toBytes(),
              }],
            });
          }}
        >
          Publish normal block
        </button>
        <button
          onClick={async () => {
            const badBlock = await client.ctx.get(BlockBuilder).publish({
              body: str2bin('abc'),
              satisfies: [{
                contract_hash: constants.rootHash,
                params: Hash.random().toBytes(),
              }],
            });
            client.ctx.get(LitigationService)
              .litigate(badBlock, [], 'VALID_CHALLENGE');
          }}
        >
          Publish bad block
        </button>
        <button onClick={() => client.ctx.get(FrontierService2).mergeAll()}>
          Merge frontier
        </button>

        <br />
        <select
          value={selectedContract}
          onChange={(e) => selectContract(e.target.value)}
        >
          {contractHashes.map(([name, hash]) => (
            <option value={hash.toHex()}>{name} ({hash.toHex()})</option>
          ))}
        </select>
        <br />
        <Input label='Params' value={params} setValue={setParams} />
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
          REQUEST
        </button>
        <br />
        <Input label='Body' value={body} setValue={setBody} />
        <button
          onClick={() =>
            client.ctx.get(BlockBuilder).publish({
              body: str2bin(body),
              satisfies: [{
                contract_hash: Hash.fromHex(selectedContract!),
                params: str2bin(params),
              }],
            })}
        >
          PROVIDE
        </button>

        <br />
        {
          /*
        <a href='#' onClick={() => client.ctx.get(AccountService)}>
          Start account loop
        </a>
        */
        }

        {
          /*
      <StoreSelector
        ctx={client.ctx}
        onSelectClass={(clz) => setShownStore({ key: Math.random(), clz })}
      />
      {shownStore.clz && (
        <StoreView
          key={shownStore.key}
          ctx={client.ctx}
          Table={shownStore.clz}
        />
      )}
        */
        }

        <button onClick={() => client.close()}>STOP</button>
        <br />

        <FactView
          ctx={client.ctx}
          selectedHash={selectedHash}
          setSelectedHash={setSelectedHash}
          hoveredHash={hoveredHash}
          setHoveredHash={setHoveredHash}
        />

        <BlockTableView
          ctx={client.ctx}
          selectedHash={selectedHash}
          setSelectedHash={setSelectedHash}
          hoveredHash={hoveredHash}
          setHoveredHash={setHoveredHash}
        />
        {/*<JsonView name='WorkQueue' ctx={client.ctx} Table={WorkQueue} />*/}

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
    </>
  );
};

import React from 'react';
import SblClient from './SblClient.ts';
import Hash from '~/sbl/util/Hash.ts';
// import BlockService from '~/sbl/BlockService.ts';
import IncentiveService from '~/sbl/IncentiveService.ts';
import CollatzContract from '../graph/CollatzContract.ts';
import { IncentiveRegistry } from '../sbl/registries.ts';
import BlockTableView from './BlockTableView.tsx';
import AccountService from '../sbl/AccountService.ts';
import Store2 from '../sbl/util/Store2.ts';
import {
  BlocksByVerifierStore,
  BlockStore,
  WorkableIncentivesStore,
} from '../sbl/stores.ts';
import GenericTableView from './GenericTableView.tsx';
import StoreSelector from './StoreSelector.tsx';
import Context from '../sbl/Context.ts';
import WorkQueue from '../sbl/WorkQueue.ts';
import StoreObserver from '../sbl/util/StoreObserver.ts';
import { Verifier } from '../sbl/messages.ts';
import Logger from '../sbl/Logger.ts';
import ThrustInitContract from '../graph/ThrustInitContract.ts';
import ThrustView from './ThrustView.tsx';
import * as moduleHashes from './moduleHashes.ts';
import * as constants from '../sbl/constants.ts';
import { decodeMultibase, str2bin } from '../sbl/pathUtils.ts';
import FetchService from '../sbl/FetchService.ts';

const initialContractHex =
  '2699c934e05e42c7937c17bfa8d0f70cb8b65f47a5330e512df5f3b621a99709';
const initialParams = `qjs --eval 'console.log(123);'`;

const contractHashes = Object.entries({ ...constants, ...moduleHashes });

const client = new SblClient();
const player = Hash.digest(client.ctx.config.selfPrivateKey);

client.ctx.get(WorkQueue);

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
      <a
        href='#'
        onClick={() => {
          const verifier = {
            contract_hash: client.ctx.get(CollatzContract).get(),
            params: client.ctx.get(CollatzContract).makeParams(10n),
          };
          client.ctx.get(IncentiveService).incentivize(verifier, 10n);

          StoreObserver.get(client.ctx.get(BlocksByVerifierStore)).observe(
            Hash.digest(Verifier.encode(verifier)),
            (blocks) =>
              console.log(
                'GOT BLOCKS',
                client.ctx.get(Logger).serialize(blocks),
              ),
          );
        }}
      >
        Collatz depth of 10
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
            (block) => console.log(block),
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
        <GenericTableView
          key={shownStore.key}
          ctx={client.ctx}
          Table={shownStore.clz}
        />
      )}

      {gameHex && (
        <>
          Game ID: <pre style={{ display: 'inline' }}>{gameHex}</pre>
          {
            <ThrustView
              sbl={client.ctx}
              match={Hash.fromHex(gameHex)}
              player={player}
            />
          }
        </>
      )}
    </div>
  );
};

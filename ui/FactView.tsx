import React from 'react';
import {
  BsBox,
  BsBoxes,
  BsInfoCircle,
  BsQuestionCircle,
  BsTree,
} from 'react-icons/bs';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import FactService from '~/sbl/FactService.ts';
import HashView from '~/ui/HashView.tsx';
import Hash, { HashPrimitive, ZERO_HASH } from '~/sbl/util/Hash.ts';
import { Fact, FactSource, FactType } from '~/sbl/FactMeta.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { match } from '~/sbl/util/functional.ts';
import { BlockInput } from '~/sbl/messages.ts';
import CollateralUtil from '~/sbl/CollateralUtil.ts';

const makeTypeIcon = (type: FactType) => {
  switch (type) {
    case FactType.NodeInfo:
      return <BsInfoCircle />;
    case FactType.Block:
      return <BsBox />;
    case FactType.BlockSet:
      return <BsBoxes />;
    case FactType.BlockSetTreeNode:
      return <BsTree />;
    default:
      return <BsQuestionCircle />;
  }
};

const Detail = (
  { label, children }: { label: string; children: React.ReactNode },
) => (
  <div>
    <label
      style={{
        color: '#999',
        width: '8em',
        display: 'inline-block',
        textAlign: 'right',
        marginRight: '0.5em',
      }}
    >
      {label}
    </label>
    <span
      style={{
        color: '#34373f',
        // fontFamily: 'Consolas,monaco,monospace',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </span>
  </div>
);

const formatByteLen = (len: number) => {
  if (len < 1024) {
    return `${len} bytes`;
  }
  len >>>= 10;
  if (len < 1024) {
    return `${len} kb`;
  }
  len >>>= 10;
  if (len < 1024) {
    return `${len} mb`;
  }
  len >>>= 10;
  return `${len} gb`;
};

export default (
  { ctx, selectedHash, setSelectedHash, hoveredHash, setHoveredHash }: {
    ctx: Context;
    selectedHash?: HashPrimitive;
    setSelectedHash(primitive?: HashPrimitive): void;
    hoveredHash?: HashPrimitive;
    setHoveredHash(primitive?: HashPrimitive): void;
  },
) => {
  if (selectedHash === undefined) {
    return;
  }

  const fact = ctx.get(FactService).get(Hash.fromPrimitive(selectedHash));
  if (fact === undefined) {
    return;
  }

  const detailExtractors: Record<string, React.ReactNode> = {
    'HASH': (
      <HashView
        hash={fact.hash}
        setHoveredHash={setHoveredHash}
        setSelectedHash={setSelectedHash}
      />
    ),
    'SOURCE': FactSource[fact.source].toUpperCase(),
    'TIMESTAMP': 'timestamp' in fact
      ? new Date(Number(fact.timestamp)).toISOString()
      : undefined,
    'RECVD TIME': 'receivedTimestamp' in fact
      ? new Date(Number(fact.receivedTimestamp)).toISOString()
      : undefined,
    'RECV COUNT': 'fromNodes' in fact ? fact.fromNodes.length : undefined,
    'SEND COUNT': 'toNodes' in fact ? fact.toNodes.length : undefined,
    'TOTAL SIZE': formatByteLen(fact.data.byteLength),
    'BODY SIZE': 'body' in fact
      ? formatByteLen(fact.body.byteLength)
      : undefined,
    'SIGNATURE': fact.signature !== undefined
      ? bin2hex(fact.signature)
      : 'no signature',
    'SIGNER': fact.signature !== undefined
      ? match(ctx.get(FactService).getPublicKey(fact), bin2hex, () => 'unknown')
      : undefined,
    'INPUTS': 'inputs' in fact ? fact.inputs.length : undefined,
    'OUTPUTS': 'outputs' in fact ? fact.outputs.length : undefined,
    'THROUGHPUT': 'outputs' in fact
      ? Number(fact.outputs.reduce((acc, cur) => acc + cur.amount, 0n))
      : undefined,
    'IS VALID':
      CollateralUtil.isValid(CollateralUtil.buildTree(fact.collateralizations))
        ? 'yes'
        : 'no',
    'FRONTIER VOTE':
      'frontier_vote' in fact && !Hash.equals(fact.frontier_vote, ZERO_HASH)
        ? (
          <HashView
            hash={fact.frontier_vote}
            setHoveredHash={setHoveredHash}
            setSelectedHash={setSelectedHash}
          />
        )
        : undefined,
    'VOTES': 'votes' in fact ? Number(fact.votes) : undefined,
    'LEVEL': 'frontierParams' in fact ? fact.frontierParams.level : undefined,
  };

  return (
    <div style={{ border: '1px solid silver' }}>
      <div>{makeTypeIcon(fact.type)} {FactType[fact.type]}</div>
      <div style={{ display: 'flex' }}>
        {'inputs' in fact && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-evenly',
            }}
          >
            {fact.inputs.map((input) => (
              <div>
                <HashView
                  hash={input.block_hash}
                  setHoveredHash={setHoveredHash}
                  setSelectedHash={setSelectedHash}
                />
              </div>
            ))}
          </div>
        )}
        <div style={{ flex: 2 }}>
          {Object.entries(detailExtractors).map(([label, node]) =>
            node !== undefined
              ? <Detail label={label.toUpperCase()}>{node}</Detail>
              : undefined
          )}
        </div>
        {'outputs' in fact && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-evenly',
            }}
          >
            {fact.outputs.map((output, idx) => (
              <div>{Number(output.amount)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

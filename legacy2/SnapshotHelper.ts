import { BlockMetrics } from './BlockMetrics.ts';
import { Context } from './Context.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { DetailVote } from './CollateralUtil.ts';
import { Connection } from './Connection.ts';
import { dataTreeToJson } from './DataTreeHelper.ts';
import {
  BlockFact,
  Collateralization,
  Fact,
  FactBase,
  FactRef,
  FactType,
  Reception,
} from './FactMeta.ts';
import { DataTree } from './protocol/base.ts';
import { Snapshot, SnapshotValue } from './SnapshotService.ts';
import { Hash } from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
import { Block, BlockInput, BlockOutput, Squash, Verifier } from './messages.ts';
import { BlockDraft, InputSpec, OutputSpec } from './BlockBuilder.ts';
import { OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';

export class SnapshotHelper {
  constructor(private ctx: Context) {}

  idConnection(conn: Connection) {
    return {
      connection: conn.sillyName,
    } satisfies Snapshot;
  }
  idHash(hash: Hash) {
    return {
      hash: hash.toHex(),
    } satisfies Snapshot;
  }
  idFact(fact: Fact | FactRef | typeof ZERO_BLOCK) {
    return (fact === ZERO_BLOCK
      ? { fact: 'ZERO_BLOCK' }
      : { fact: fact.hash.toHex() }) satisfies Snapshot;
  }

  snapshotFact(fact: Fact | FactRef): Snapshot {
    if (fact.type === FactType.Ref) {
      return this.snapshotFactRef(fact);
    } else if (fact.type === FactType.Block) {
      return this.snapshotBlockFact(fact);
    } else if (fact.type === FactType.PeerInfo) {
      return { omit: 'PeerInfo' };
    } else if (fact.type === FactType.ConnectionSignal) {
      return { omit: 'ConnectionSignal' };
    } else if (fact.type === FactType.Index) {
      return { omit: 'Index' };
    } else {
      throw new Error(`Unknown fact type: ${(fact as Fact).type}`);
    }
  }

  snapshotFactRef(fact: FactRef): Snapshot {
    return {
      hash: fact.hash.toHex(),
      receptions: this.seq(fact.receptions, this.snapshotReception),
      requesting: this.seq(fact.requesting, this.idConnection),
      collateralizations: this.seq(fact.collateralizations, this.snapshotCollateralization),
      validities: this.map(fact.validities, String, this.snapshotValidity),
    };
  }

  snapshotReception(reception: Reception): Snapshot {
    return {
      timestamp: reception.timestamp,
      conn: this.idConnection(reception.conn),
      full: reception.full,
    };
  }

  snapshotCollateralization(collateralization: Collateralization): Snapshot {
    return {
      collateralBlock: this.idFact(collateralization.collateralBlock),
      collateralOutputIdx: collateralization.collateralOutputIdx,
      detail: this.snapshotCollateralContractDetail(collateralization.detail),
      amount: Number(collateralization.amount),
    };
  }

  snapshotCollateralContractDetail(detail: CollateralContractDetail): Snapshot {
    return {
      publicKey: bin2hex(detail.publicKey),
      hints: detail.hints.map((hint) => this.snapshotDataTree(hint)),
      vote: detail.vote,
    };
  }

  snapshotValidity(validity: { path: DataTree[]; vote: DetailVote }): Snapshot {
    return {
      path: this.seq(validity.path, this.snapshotDataTree),
      vote: validity.vote,
    };
  }

  snapshotDataTree(dataTree: DataTree): Snapshot {
    return {
      dataTree: dataTreeToJson(dataTree),
    };
  }

  snapshotFactBase(fact: FactBase): Snapshot {
    return {
      hash: fact.hash.toHex(),
      signer: fact.signer !== undefined ? bin2hex(fact.signer) : undefined,
      receivedAt: fact.receivedAt,
      source: fact.source,
      fromConnections: this.seq(fact.fromConnections, this.idConnection),
      usefulness: fact.usefulness,
      publishAt: fact.publishAt,
      toConnections: this.seq(fact.toConnections, this.idConnection),
      visitedAt: fact.visitedAt,
      visitedBy: fact.visitedBy,
      references: fact.references,
      factIdx: fact.factIdx,
      typeStr: fact.typeStr,
      sourceStr: fact.sourceStr,
      sillyName: fact.sillyName,
      backtrace: fact.backtrace,
    };
  }

  snapshotBlockFact(fact: BlockFact): Snapshot {
    return {
      ...this.snapshotFactBase(fact),
      ...this.snapshotBlock(fact),
      ...this.snapshotBlockMeta(fact),
      ...this.snapshotBlockMetrics(fact),
    };
  }

  snapshotBlock(block: Block): Snapshot {
    return {
      parent: this.idHash(block.parent),
      squashes: this.seq(block.squashes, this.snapshotSquash),
      volume: block.volume,
      squashedUtxoIdxs: block.squashedUtxoIdxs,
      treeWeights: this.seq(block.treeWeights, Number),
      refs: this.seq(block.refs, this.idHash),
      inputs: this.seq(block.inputs, this.snapshotBlockInput),
      outputs: this.seq(block.outputs, this.snapshotBlockOutput),
      body: this.snapshotDataTree(block.body),
      claimWeightBoost: Number(block.claimWeightBoost),
      timestamp: Number(block.timestamp),
    };
  }

  snapshotSquash(squash: Squash): Snapshot {
    return {
      blockHash: this.idHash(squash.blockHash),
      newUtxoCount: squash.newUtxoCount,
    };
  }

  snapshotBlockInput(input: BlockInput): Snapshot {
    return {
      blockHash: this.idHash(input.blockHash),
      outputIdx: input.outputIdx,
      utxoIdx: input.utxoIdx,
      groupIdx: input.groupIdx,
    };
  }

  snapshotBlockOutput(output: BlockOutput): Snapshot {
    return {
      verifier: this.snapshotVerifier(output.verifier),
      amount: Number(output.amount),
      detail: this.snapshotDataTree(output.detail),
      groupIdx: output.groupIdx,
    };
  }

  snapshotVerifier(verifier: Verifier): Snapshot {
    return {
      contractHash: this.idHash(verifier.contractHash),
      params: this.snapshotDataTree(verifier.params),
    };
  }

  snapshotBlockMeta(fact: BlockFact): Snapshot {
    return {
      childWeight: Number(fact.childWeight),
      claims: this.map(fact.claims, String, (x) => this.seq(x, this.idFact)),
      conflicts: this.map(fact.conflicts, (x) => this.idFact(x).fact, Number),
      descWeight: Number(fact.descWeight),
      treeParent: fact.treeParent !== undefined ? this.idFact(fact.treeParent) : undefined,
      canonicality: Number(fact.canonicality),
      flags: fact.flags,
      claimedWork: Number(fact.claimedWork),
      votes: Number(fact.votes),
      derivedWork: fact.derivedWork,
      mergeableProbability: fact.mergeableProbability,
      inputOutputIdxs: fact.inputOutputIdxs,
      outputClaims: this.seq(
        fact.outputClaims,
        (claim) => this.seq(claim, this.snapshotOutputClaim),
      ),
      isCanonical: fact.isCanonical,
      parentBlock: fact.parentBlock !== undefined ? this.idFact(fact.parentBlock) : undefined,
      parentChainRoot: fact.parentChainRoot !== undefined
        ? this.idFact(fact.parentChainRoot)
        : undefined,
      parentChainDepth: fact.parentChainDepth,
      children: this.seq(fact.children, this.idFact),
      utxoCount: fact.utxoCount,
      propagationMask: fact.propagationMask,
      derivedWorkValue: fact.derivedWorkValue,
      derivedWorkError: fact.derivedWorkError,
      mergeableLogProbabilityValue: fact.mergeableLogProbabilityValue,
      mergeableLogProbabilityError: fact.mergeableLogProbabilityError,
      canonicalityOld: fact.canonicalityOld,
      collateral: fact.collateral,
      squashers: this.seq(fact.squashers, this.idFact),
      persistentSources: this.seq(fact.persistentSources, this.snapshotBlockDraft),
    };
  }

  snapshotOutputClaim(claim: OutputClaim): Snapshot {
    return {
      block: this.idFact(claim.block),
      inputIdx: claim.inputIdx,
    };
  }

  snapshotBlockDraft(draft: BlockDraft): Snapshot {
    return {
      groupIdx: draft.groupIdx,
      squashOutputAmount: Number(draft.squashOutputAmount),
      refs: draft.refs !== undefined ? this.seq(draft.refs, this.idFact) : undefined,
      inputs: draft.inputs !== undefined
        ? this.seq(draft.inputs, this.snapshotDraftInput)
        : undefined,
      satisfies: draft.satisfies !== undefined
        ? this.seq(draft.satisfies, this.snapshotVerifier)
        : undefined,
      outputs: draft.outputs !== undefined
        ? this.seq(draft.outputs, this.snapshotDraftOutput)
        : undefined,
      body: draft.body !== undefined ? this.snapshotDataTree(draft.body) : undefined,
      claimWeightBoost: Number(draft.claimWeightBoost),
      timeout: draft.timeout,
      deadline: draft.deadline,
    };
  }

  snapshotDraftInput(input: InputSpec): Snapshot {
    return {
      blockHash: this.idHash(input.block.hash),
      outputIdx: input.outputIdx,
      amount: Number(input.amount),
    };
  }

  snapshotDraftOutput(output: OutputSpec): Snapshot {
    return {
      verifier: this.snapshotVerifier(output.verifier),
      amount: Number(output.amount),
      detail: this.snapshotDataTree(output.detail),
    };
  }

  snapshotBlockMetrics(fact: BlockFact): Snapshot {
    return {
      selfWork: Number(this.ctx.get(BlockMetrics).get(fact, 'selfWork')),
      freeMarketOutput: Number(this.ctx.get(BlockMetrics).get(fact, 'freeMarketOutput')),
      conservativeSelfWork: Number(this.ctx.get(BlockMetrics).get(fact, 'conservativeSelfWork')),

      childWeight: Number(this.ctx.get(BlockMetrics).get(fact, 'childWeight')),
      childWeight1: Number(this.ctx.get(BlockMetrics).get(fact, 'childWeight1')),
      childWeights2: this.seq(this.ctx.get(BlockMetrics).get(fact, 'childWeights2'), Number),

      ancestorWeight: Number(this.ctx.get(BlockMetrics).get(fact, 'ancestorWeight')),
      descendantWeight: Number(this.ctx.get(BlockMetrics).get(fact, 'descendantWeight')),

      conflictScore: Number(this.ctx.get(BlockMetrics).get(fact, 'conflictScore')),
      isConflictWinner: this.ctx.get(BlockMetrics).get(fact, 'isConflictWinner'),
      isCanonical: this.ctx.get(BlockMetrics).get(fact, 'isCanonical'),
    };
  }

  seq<T>(seq: T[] | Set<T>, snapshotter: (item: T) => SnapshotValue): Snapshot {
    if (seq instanceof Set) {
      seq = Array.from(seq);
    }
    return seq.map((item) => snapshotter.call(this, item));
  }

  map<K, V>(
    map: Map<K, V>,
    keySnapshotter: (key: K) => string,
    valueSnapshotter: (item: V) => SnapshotValue,
  ): Snapshot {
    return Object.fromEntries([...map.entries()]
      .map(([key, value]) => [keySnapshotter.call(this, key), valueSnapshotter.call(this, value)]));
  }
}

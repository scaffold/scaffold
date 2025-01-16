import { assert, assertEquals, assertObjectMatch, assertThrows } from '@std/assert';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import { BlockService } from '../src/BlockService.ts';
import { error } from '../src/util/functional.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { Hash } from '../src/util/Hash.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { frontierHash, trueHash } from '../src/hashes.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';
import { FrontierService } from '../src/FrontierService.ts';
import { BlockFact } from '../src/FactMeta.ts';
import { BlockDraft } from '../src/BlockBuilder.ts';
import { NoBlockPathFound } from '../src/exceptions.ts';
import { WalkerService } from '../src/WalkerService.ts';

const sequence: { key: string; fv: string; tc: string[]; in: string[]; out: number }[] = [
  { key: 'a', fv: 'G', tc: [], in: [], out: 2 },
  { key: 'b', fv: 'Z', tc: ['G', 'a'], in: ['a.0'], out: 2 },

  { key: 'c', fv: 'a', tc: [], in: ['a.1'], out: 3 },
  { key: 'd', fv: 'c', tc: [], in: [], out: 1 },
];

Deno.test(
  {
    name: `FrontierService.getUtxoIdx and FrontierService.getOutput`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
  }, (_testCtx, ctx) => {
    const genesisHash = provideInitialBalance(ctx);

    const blocks = new Map<string, BlockFact>();

    const genesis = ctx.get(BlockService).get(genesisHash, false) ??
      error(`Missing genesis block!`);
    genesis.sillyName = `G/${genesis.sillyName}`;
    blocks.set('G', genesis);
    console.log(
      `Added ${genesis.sillyName}: ${genesis.inputs.length} inputs -> ${genesis.outputs.length} outputs`,
    );

    for (const entry of sequence) {
      const frontierVote = entry.fv === 'Z'
        ? ZERO_BLOCK
        : blocks.get(entry.fv) ?? error(`Invalid fv ${entry.fv}`);

      const drafts: BlockDraft[] = [
        {
          groupIdx: 0,
          inputs: entry.tc.map((tc) =>
            findOutput(blocks.get(tc) ?? error(`Invalid tc ${tc}`), frontierHash)
          ),
        },
        ...entry.in.map((x) => {
          const [key, idx] = x.split('.');
          const block = blocks.get(key) ?? error(`Invalid in key ${key}`);
          let outputIdx = parseInt(idx);
          outputIdx = block.outputs.findIndex((x) =>
            Hash.equals(x.verifier.contractHash, trueHash) && outputIdx-- === 0
          );
          if (outputIdx === -1) {
            throw new Error(`Input ${x} does not exist`);
          }
          const amount = block.outputs[outputIdx].amount;
          return { inputs: [{ block, outputIdx, amount }] };
        }),
        ...Array.from(
          { length: entry.out },
          () => ({
            outputs: [{
              verifier: { contractHash: trueHash, params: EMPTY_ARR },
              amount: 1n,
              detail: EMPTY_ARR,
            }],
          }),
        ),
      ];

      const created = ctx.get(BlockService).create(ctx.get(BlockBuilder).buildBlock(drafts));
      created.sillyName = `${entry.key}/${created.sillyName}`;
      blocks.set(entry.key, created);

      console.log(
        `Added ${created.sillyName}: ${created.inputs.length} inputs -> ${created.outputs.length} outputs`,
      );

      let utxoIdx = 0;
      let skippedCount = 0;
      for (const block of blocks.values().toArray().toReversed()) {
        for (let outputIdx = 0; outputIdx < block.outputs.length; outputIdx++) {
          const visibleClaims = block.outputClaims[outputIdx].filter((x) =>
            x.block !== created && ctx.get(WalkerService).getPath(x.block, created) !== undefined
          );
          if (visibleClaims.length !== 0) {
            console.log(
              `  ${block.sillyName}.${outputIdx}: claimed by ${
                visibleClaims.map((x) => x.block.sillyName + '.' + x.inputIdx).join(',')
              }`,
            );
            continue;
          }

          try {
            assertEquals(ctx.get(FrontierService).getUtxoIdx(block, outputIdx, created), utxoIdx);
            console.log(`  ${block.sillyName}.${outputIdx}: utxo ${utxoIdx}`);
          } catch (err) {
            if (err instanceof NoBlockPathFound) {
              console.log(
                `  ${block.sillyName}.${outputIdx}: no path found to ${created.sillyName}`,
              );

              skippedCount++;
              continue;
            } else {
              console.log(`  ${block.sillyName}.${outputIdx}: expected utxo ${utxoIdx}`);

              throw err;
            }
          }

          assertEquals(ctx.get(FrontierService).getOutput(created, utxoIdx), { block, outputIdx });

          utxoIdx++;
        }
      }

      assertEquals(
        utxoIdx - created.inputs.length, // 5
        ctx.get(FrontierService).getTotalUtxoCount(created), // 4
      );

      console.log(`Tested ${utxoIdx} utxos from ${blocks.size} blocks; skipped ${skippedCount}`);
    }
  }),
);

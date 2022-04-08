import { Sha256 } from 'https://deno.land/std@0.134.0/hash/sha256.ts';

// TODO: Move these to WASM

const contracts = [];

contracts.push({
  name: 'epoch',
  contractName: 'epoch',
  isCorrect: true,
  func: (params: any, request: (contractName: string, params: any) => any) => {
    const prevEpoch = params ? request('epoch', params - 1) : '';
    const delta = request('delta', params);

    const algo = new Sha256();
    algo.update(prevEpoch + delta);
    return algo.hex();
  },
});

contracts.push({
  name: 'delta',
  contractName: 'delta',
  isCorrect: true,
  func: (params: any, request: (contractName: string, params: any) => any) => {
    return '';
  },
});

contracts.push({
  name: 'balance',
  contractName: 'balance',
  isCorrect: true,
  func: (params: any, request: (contractName: string, params: any) => any) => {
    return '';
  },
});

// 256-level merkle tree for account balances
// This allows efficient (1) balance testing and (2) updating
// Event stream, where each event updates one leaf in the merkle tree
// Each event/update/transaction should check balance before updating

import { bin2str, str2bin } from '../../util/buffer.ts';
import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const CHESS_CONTRACT = Hash.digest('chess');

export interface ChessState {}

function reduceChessState(state: ChessState, action: never): ChessState {
  return state;
}

const initialState: ChessState = {};

export const chessContract: Contract = {
  async run(env) {
    // The chess contract should be created with `scaffold.put({ move })`
    // This has the advantage over a separate move output that invalid moves are immediately rejected

    const params = JSON.parse(bin2str(env.params()));
    const match = Hash.fromHex(params.match);
    const move = Number(params.move);

    if (move === 0) {
      env.send(CHESS_CONTRACT, str2bin(JSON.stringify(initialState)), 0n);
      return;
    }

    const prevParams = str2bin(JSON.stringify({ match, move: move - 1 }));
    const prevClaim = await env.claimOne({ contract: CHESS_CONTRACT, params: prevParams });
    const prevState: ChessState = JSON.parse(bin2str(prevClaim.body));
    const action = JSON.parse(bin2str(env.getResult()));

    const state: ChessState = reduceChessState(prevState, action);
    env.send(CHESS_CONTRACT, str2bin(JSON.stringify(state)), prevClaim.amount);
  },

  debug(params) {
    return `chess(${bin2str(params)})`;
  },
};

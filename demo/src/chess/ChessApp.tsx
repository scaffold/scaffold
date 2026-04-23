import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Scaffold } from 'scaffold.io/Scaffold.ts';
import { composeGenesisPacket } from 'scaffold.io/core/Packet.ts';
import { makeSignatureOutput } from 'scaffold.io/contracts/SignatureContract.ts';
import { secp } from 'scaffold.io/util/secp.ts';
import { bin2hex } from 'scaffold.io/util/hex.ts';
import { ChessGame } from 'scaffold.io/demo/chess/ChessGame.ts';
import { ChessIndex } from 'scaffold.io/demo/chess/ChessIndex.ts';
import { BalanceIndex } from 'scaffold.io/demo/chess/BalanceIndex.ts';
import { encodeMove } from 'scaffold.io/demo/chess/GameStateCodec.ts';
import { Board } from './Board.tsx';
import { Clock } from './Clock.tsx';
import { Wallet } from './Wallet.tsx';
import { GameList } from './GameList.tsx';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

let toastCounter = 0;

export function ChessApp() {
  const { scaffold, chess, chessIndex, balanceIndex } = useMemo(() => {
    const priv = secp.utils.randomPrivateKey();
    const pub = secp.getPublicKey(priv, true);
    const { block: genesis } = composeGenesisPacket([
      makeSignatureOutput(pub, 10_000),
    ]);
    const sc = new Scaffold({ privateKey: priv, genesis });
    const g = new ChessGame(sc);
    return {
      scaffold: sc,
      chess: g,
      chessIndex: new ChessIndex(sc, g),
      balanceIndex: new BalanceIndex(sc),
    };
  }, []);

  const myPubkey = scaffold.publicKey;
  const myPubkeyHex = bin2hex(myPubkey);

  const [version, setVersion] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const u1 = chessIndex.onChange(() => setVersion((v) => v + 1));
    const u2 = balanceIndex.onChange(() => setVersion((v) => v + 1));
    const u3 = chess.onPendingChange(() => setVersion((v) => v + 1));
    return () => {
      u1();
      u2();
      u3();
    };
  }, [chessIndex, balanceIndex, chess]);

  const pushToast = useCallback(
    (message: string, kind: 'info' | 'error' = 'info') => {
      const id = ++toastCounter;
      setToasts((ts) => [...ts, { id, message, kind }]);
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
    },
    [],
  );

  const myGames = chessIndex.myGames(myPubkey);
  const openGames = chessIndex
    .openGames()
    .filter((g) => !bytesEqual(g.state.white, myPubkey));

  // Auto-select first active game.
  useEffect(() => {
    if (activeGameId) return;
    const first = myGames[0];
    if (first) setActiveGameId(bin2hex(first.gameId));
  }, [activeGameId, myGames]);

  const selected = activeGameId ? chessIndex.get(activeGameId) : undefined;

  // For the selected active game, if it's our turn, eagerly put a `move`
  // prompt into the wrapper's store. The generator parks on getOutput
  // waiting for our handler; when the user clicks a move, we resolve the
  // prompt and the generator wakes.
  useEffect(() => {
    if (!selected) return;
    const s = selected.state.state;
    if (s.status !== 1 /* in_progress */) return;
    const onMove = s.toMove === 0 ? selected.state.white : selected.state.black;
    if (!bytesEqual(onMove, myPubkey)) return;
    chess.promptMove(selected.gameId, selected.turnId);
  }, [chess, selected, myPubkey, version]);

  const { free, locked } = balanceIndex.getBalance(myPubkey);

  const handleCreate = useCallback(() => {
    try {
      const stake = 100;
      if (free < stake) {
        pushToast(`Need ${stake} free balance to create a game`, 'error');
        return;
      }
      const gameId = chess.createGame(stake);
      setActiveGameId(bin2hex(gameId));
      pushToast(`Created game #${bin2hex(gameId).slice(0, 8)}`);
    } catch (e) {
      pushToast((e as Error).message, 'error');
    }
  }, [chess, pushToast, free]);

  const handleJoin = useCallback(
    (gameId: Uint8Array) => {
      // Joining = telling the generator "I am black": post a 'join'
      // prompt on the current (awaiting_join) turn, then resolve it with
      // our pubkey. The generator's requireSignature will pass because
      // we're the only node signing with this key.
      const active = chessIndex.get(gameId);
      if (!active) {
        pushToast('game not found', 'error');
        return;
      }
      if (active.state.state.status !== 0 /* awaiting_join */) {
        pushToast('game is not awaiting a join', 'error');
        return;
      }
      const prompt = chess.promptJoin(active.gameId, active.turnId);
      prompt.resolve(myPubkey);
      setActiveGameId(bin2hex(active.gameId));
      pushToast(`Joining #${bin2hex(active.gameId).slice(0, 8)}`);
    },
    [chess, chessIndex, myPubkey, pushToast],
  );

  const handleSelect = useCallback((gameId: Uint8Array) => {
    setActiveGameId(bin2hex(gameId));
  }, []);

  const handleMove = useCallback(
    (from: number, to: number) => {
      if (!selected) return;
      const promoting = isPromotion(selected.state.state.board, from, to);
      const move = {
        from,
        to,
        promotion: promoting ? queenFor(selected.state.state.toMove) : 0,
      };
      const key = bin2hex(selected.gameId) + ':' + selected.turnId + ':move';
      chess.resolvePrompt(key, encodeMove(move));
    },
    [chess, selected],
  );

  const amWhite = selected ? bytesEqual(selected.state.white, myPubkey) : false;
  const amBlack = selected ? bytesEqual(selected.state.black, myPubkey) : false;
  const orientation: 0 | 1 = amBlack ? 1 : 0;
  const status = selected?.state.state.status ?? -1;
  const terminal = status >= 2;
  const amOnMove = selected &&
    !terminal &&
    ((selected.state.state.toMove === 0 && amWhite) ||
      (selected.state.state.toMove === 1 && amBlack));

  return (
    <div style={{ ...pageStyle, fontFamily: '-apple-system, sans-serif' }}>
      <div style={leftPaneStyle}>
        <Wallet pubkeyHex={myPubkeyHex} free={free} locked={locked} />
        <GameList
          openGames={openGames}
          myGames={myGames}
          myPubkey={myPubkey}
          activeGameId={activeGameId}
          onCreate={handleCreate}
          onJoin={handleJoin}
          onSelect={handleSelect}
        />
      </div>

      <div style={boardPaneStyle}>
        {selected
          ? (
            <>
              <div style={boardHeaderStyle}>
                <div>
                  <div style={gameTitleStyle}>
                    Game #{bin2hex(selected.gameId).slice(0, 8)}
                  </div>
                  <div style={gameSubtitleStyle}>
                    {describeStatus(status)} · pot {selected.value.toLocaleString()}
                  </div>
                </div>
                <div style={clockRowStyle}>
                  <Clock
                    label={amBlack ? 'Opponent (White)' : 'White'}
                    baseMs={selected.state.state.whiteClockMs}
                    lastMoveAt={selected.state.state.lastMoveAt}
                    ticking={!terminal && selected.state.state.toMove === 0}
                  />
                  <Clock
                    label={amWhite ? 'Opponent (Black)' : 'Black'}
                    baseMs={selected.state.state.blackClockMs}
                    lastMoveAt={selected.state.state.lastMoveAt}
                    ticking={!terminal && selected.state.state.toMove === 1}
                  />
                </div>
              </div>
              <Board
                board={selected.state.state.board}
                orientation={orientation}
                onMove={handleMove}
                disabled={terminal || !amOnMove}
              />
              {version < 0 && null /* re-render dep */}
            </>
          )
          : (
            <div style={placeholderStyle}>
              <div style={{ fontSize: 72, marginBottom: 16 }}>♟</div>
              <div style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
                Scaffold Chess
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: '#6e6e73',
                  maxWidth: 360,
                  textAlign: 'center',
                }}
              >
                Create a game or join an open one. Each move flows through a generator: the contract
                blocks on getOutput, and clicking a square resolves the pending prompt.
              </div>
            </div>
          )}
      </div>

      <div style={toastContainerStyle}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              ...toastStyle,
              background: t.kind === 'error' ? '#ff3b30' : '#1d1d1f',
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function describeStatus(s: number): string {
  switch (s) {
    case 0:
      return 'Awaiting an opponent';
    case 1:
      return 'In progress';
    case 2:
      return 'White won by checkmate';
    case 3:
      return 'Black won by checkmate';
    case 4:
      return 'Draw';
    case 5:
      return 'White timed out';
    case 6:
      return 'Black timed out';
    default:
      return '';
  }
}

function isPromotion(board: Uint8Array, from: number, to: number): boolean {
  const piece = board[from];
  if (piece === 1 /* W_PAWN */) return Math.floor(to / 8) === 7;
  if (piece === 7 /* B_PAWN */) return Math.floor(to / 8) === 0;
  return false;
}

function queenFor(toMove: number): number {
  return toMove === 0 ? 5 /* W_QUEEN */ : 11 /* B_QUEEN */;
}

const pageStyle: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  padding: 24,
  background: '#f5f5f7',
  minHeight: 'calc(100vh - 48px)',
};

const leftPaneStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const boardPaneStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  alignItems: 'flex-start',
  flex: 1,
};

const boardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  width: '100%',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 24,
};

const gameTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: '#1d1d1f',
  fontFamily: 'ui-monospace, monospace',
};

const gameSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#6e6e73',
  marginTop: 2,
};

const clockRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
};

const placeholderStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#8e8e93',
  padding: 48,
  width: '100%',
};

const toastContainerStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
};

const toastStyle: React.CSSProperties = {
  color: '#fff',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
  maxWidth: 320,
};

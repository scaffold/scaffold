import React from 'react';
import type { ActiveGame } from 'scaffold.io/demo/chess/ChessGame.ts';
import { bin2hex } from 'scaffold.io/util/hex.ts';

interface GameListProps {
  openGames: ActiveGame[];
  myGames: ActiveGame[];
  myPubkey: Uint8Array;
  activeGameId: string | null;
  onJoin: (gameId: Uint8Array) => void;
  onSelect: (gameId: Uint8Array) => void;
  onCreate: () => void;
}

function shortId(g: ActiveGame): string {
  return bin2hex(g.gameId).slice(0, 8);
}

function toMoveLabel(g: ActiveGame): string {
  switch (g.state.state.status) {
    case 0:
      return 'awaiting join';
    case 1:
      return g.state.state.toMove === 0 ? 'white to move' : 'black to move';
    case 2:
      return 'white won';
    case 3:
      return 'black won';
    case 4:
      return 'draw';
    case 5:
      return 'white timed out';
    case 6:
      return 'black timed out';
    default:
      return 'unknown';
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function GameList({
  openGames,
  myGames,
  myPubkey,
  activeGameId,
  onJoin,
  onSelect,
  onCreate,
}: GameListProps) {
  const renderGame = (g: ActiveGame) => {
    const id = bin2hex(g.gameId);
    const isSelected = id === activeGameId;
    const isMine = bytesEqual(g.state.white, myPubkey) ||
      (!g.state.black.every((b) => b === 0) && bytesEqual(g.state.black, myPubkey));
    const canJoin = g.state.state.status === 0 && !isMine;
    return (
      <div
        key={id}
        style={{
          ...gameRowStyle,
          border: isSelected ? '2px solid #0071e3' : '1px solid #d2d2d7',
          background: isSelected ? '#f0f7ff' : '#ffffff',
        }}
        onClick={() => onSelect(g.gameId)}
      >
        <div style={gameInfoStyle}>
          <div style={gameIdStyle}>#{shortId(g)}</div>
          <div style={gameMetaStyle}>
            {toMoveLabel(g)} · pot {g.value.toLocaleString()}
          </div>
        </div>
        {canJoin && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onJoin(g.gameId);
            }}
            style={joinBtnStyle}
          >
            Join
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={containerStyle}>
      <div style={sectionHeaderRow}>
        <span style={sectionHeaderStyle}>My Games ({myGames.length})</span>
        <button onClick={onCreate} style={createBtnStyle}>+ New</button>
      </div>
      {myGames.length === 0 && (
        <div style={emptyStyle}>Create a game or join an open one below.</div>
      )}
      {myGames.map(renderGame)}

      <div style={{ ...sectionHeaderStyle, marginTop: 14 }}>
        Open Games ({openGames.length})
      </div>
      {openGames.length === 0 && <div style={emptyStyle}>No open games.</div>}
      {openGames.map(renderGame)}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  width: 280,
  fontFamily: '-apple-system, sans-serif',
};

const sectionHeaderRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#6e6e73',
};

const gameRowStyle: React.CSSProperties = {
  padding: 8,
  borderRadius: 8,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
};

const gameInfoStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const gameIdStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#1d1d1f',
  fontFamily: 'ui-monospace, monospace',
};

const gameMetaStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#6e6e73',
};

const joinBtnStyle: React.CSSProperties = {
  padding: '4px 12px',
  background: '#0071e3',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const createBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  background: '#2a7a2a',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#8e8e93',
  padding: '8px 0',
  fontStyle: 'italic',
};

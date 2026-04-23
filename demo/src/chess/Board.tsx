import React, { useState } from 'react';
import { PIECE_GLYPHS } from './pieces.ts';

interface BoardProps {
  board: Uint8Array;
  /** 0 = white on bottom, 1 = flipped (black on bottom). */
  orientation?: 0 | 1;
  /**
   * Invoked when the user drags a piece from one square to another. Accepts
   * any move including illegal ones -- the caller decides whether to submit
   * to the network.
   */
  onMove?: (from: number, to: number) => void;
  /** Highlighted squares (last move, check, etc). */
  highlights?: number[];
  disabled?: boolean;
}

function squareIndex(rank: number, file: number): number {
  return rank * 8 + file;
}

export function Board({
  board,
  orientation = 0,
  onMove,
  highlights = [],
  disabled = false,
}: BoardProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [hoverSq, setHoverSq] = useState<number | null>(null);

  const ranks = orientation === 0 ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orientation === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const highlightSet = new Set(highlights);

  return (
    <div style={boardStyle}>
      {ranks.map((rank) => (
        <div key={rank} style={rowStyle}>
          {files.map((file) => {
            const idx = squareIndex(rank, file);
            const piece = board[idx];
            const isDark = (rank + file) % 2 === 0;
            const highlighted = highlightSet.has(idx);
            const isHover = hoverSq === idx && dragFrom !== null && dragFrom !== idx;
            const bg = highlighted
              ? (isDark ? '#b5a32c' : '#e8dc7a')
              : isHover
              ? (isDark ? '#7a8b5c' : '#c6d9a0')
              : (isDark ? '#b58863' : '#f0d9b5');
            return (
              <div
                key={file}
                style={{ ...squareStyle, background: bg }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setHoverSq(idx);
                }}
                onDragLeave={() => setHoverSq((s) => (s === idx ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  setHoverSq(null);
                  if (disabled) return;
                  if (dragFrom !== null && dragFrom !== idx) {
                    onMove?.(dragFrom, idx);
                  }
                  setDragFrom(null);
                }}
                onClick={() => {
                  if (disabled) return;
                  if (dragFrom === null && piece !== 0) {
                    setDragFrom(idx);
                  } else if (dragFrom !== null) {
                    if (dragFrom !== idx) onMove?.(dragFrom, idx);
                    setDragFrom(null);
                  }
                }}
              >
                {piece !== 0 && (
                  <span
                    draggable={!disabled}
                    onDragStart={() => setDragFrom(idx)}
                    onDragEnd={() => setDragFrom(null)}
                    style={{
                      ...pieceStyle,
                      cursor: disabled ? 'default' : 'grab',
                      color: piece <= 6 ? '#ffffff' : '#1d1d1f',
                      textShadow: piece <= 6 ? '0 0 2px #000' : 'none',
                      opacity: dragFrom === idx ? 0.4 : 1,
                    }}
                  >
                    {PIECE_GLYPHS[piece]}
                  </span>
                )}
                {/* Rank label on leftmost column */}
                {((orientation === 0 && file === 0) || (orientation === 1 && file === 7)) && (
                  <span style={rankLabelStyle}>{rank + 1}</span>
                )}
                {/* File label on bottom row */}
                {((orientation === 0 && rank === 0) || (orientation === 1 && rank === 7)) && (
                  <span style={fileLabelStyle}>
                    {String.fromCharCode('a'.charCodeAt(0) + file)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const boardStyle: React.CSSProperties = {
  display: 'inline-block',
  border: '4px solid #3a3a3a',
  borderRadius: 6,
  background: '#3a3a3a',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
};

const squareStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  userSelect: 'none',
};

const pieceStyle: React.CSSProperties = {
  fontSize: 42,
  lineHeight: 1,
  pointerEvents: 'auto',
};

const rankLabelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  left: 3,
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(0, 0, 0, 0.6)',
  fontFamily: '-apple-system, sans-serif',
};

const fileLabelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 2,
  right: 3,
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(0, 0, 0, 0.6)',
  fontFamily: '-apple-system, sans-serif',
};

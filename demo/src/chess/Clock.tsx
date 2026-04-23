import React, { useEffect, useState } from 'react';

interface ClockProps {
  label: string;
  /** Clock at the start of the current turn. */
  baseMs: number;
  /** Timestamp (wall clock) when the previous move landed. */
  lastMoveAt: number;
  /** Whether this side is on move (clock ticks down). */
  ticking: boolean;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '0:00.0';
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`;
}

export function Clock({ label, baseMs, lastMoveAt, ticking }: ClockProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [ticking]);

  const now = Date.now();
  const elapsed = ticking ? Math.max(0, now - lastMoveAt) : 0;
  const remaining = Math.max(0, baseMs - elapsed);
  const low = remaining < 30_000;
  const expired = remaining <= 0;

  return (
    <div
      style={{
        ...clockStyle,
        background: expired ? '#8b1a1a' : low ? '#8b6b1a' : '#2a2a2e',
        color: '#fff',
      }}
    >
      <div style={labelStyle}>{label}</div>
      <div style={timeStyle}>{formatMs(remaining)}</div>
    </div>
  );
}

const clockStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  minWidth: 140,
  fontFamily: '-apple-system, sans-serif',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  opacity: 0.8,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const timeStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
};

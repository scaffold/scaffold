import React from 'react';

interface WalletProps {
  pubkeyHex: string;
  free: number;
  locked: number;
}

export function Wallet({ pubkeyHex, free, locked }: WalletProps) {
  return (
    <div style={containerStyle}>
      <div style={rowStyle}>
        <span style={labelStyle}>Pubkey</span>
        <span style={valueStyle}>{pubkeyHex.slice(0, 8)}...{pubkeyHex.slice(-4)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Free</span>
        <span style={{ ...valueStyle, color: '#2a7a2a' }}>{free.toLocaleString()}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Locked</span>
        <span style={{ ...valueStyle, color: '#7a5a2a' }}>{locked.toLocaleString()}</span>
      </div>
      <div style={{ ...rowStyle, borderTop: '1px solid #e0e0e0', paddingTop: 6 }}>
        <span style={labelStyle}>Total</span>
        <span style={{ ...valueStyle, fontWeight: 700 }}>
          {(free + locked).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  padding: 12,
  border: '1px solid #d2d2d7',
  borderRadius: 10,
  background: '#ffffff',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 200,
  fontFamily: '-apple-system, sans-serif',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: '#6e6e73',
  fontWeight: 500,
};

const valueStyle: React.CSSProperties = {
  fontSize: 14,
  fontVariantNumeric: 'tabular-nums',
  color: '#1d1d1f',
  fontWeight: 500,
};

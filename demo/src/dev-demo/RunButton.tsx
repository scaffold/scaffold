import React from 'react';

export type RunState =
  | { kind: 'idle' }
  | { kind: 'compiling' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

interface RunButtonProps {
  state: RunState;
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function RunButton({
  state,
  onClick,
  label = 'Run',
  disabled = false,
  disabledReason,
}: RunButtonProps) {
  const isRunning = state.kind === 'compiling';
  const isDisabled = disabled || isRunning;
  const title = isDisabled && disabledReason ? disabledReason : undefined;

  let text = label;
  if (isRunning) text = 'Running…';
  else if (state.kind === 'done') text = `${label} ✓`;

  return (
    <button
      type='button'
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      style={{
        ...baseStyle,
        ...(state.kind === 'done' ? doneStyle : {}),
        ...(state.kind === 'error' ? errorStyle : {}),
        ...(isDisabled ? disabledStyle : {}),
      }}
    >
      {text}
    </button>
  );
}

const font = '-apple-system, BlinkMacSystemFont, sans-serif';

const baseStyle: React.CSSProperties = {
  padding: '5px 14px',
  background: '#0071e3',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: font,
  transition: 'opacity 0.15s',
  lineHeight: '20px',
};

const doneStyle: React.CSSProperties = {
  background: '#34c759',
};

const errorStyle: React.CSSProperties = {
  background: '#ff3b30',
};

const disabledStyle: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.55,
};

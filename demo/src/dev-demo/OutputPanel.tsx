import React from "react";

interface OutputPanelProps {
  value: string | null;
  placeholder?: string;
  /** Optional inline error -- rendered in red below the value. */
  error?: string | null;
}

export function OutputPanel({
  value,
  placeholder = "Run to populate",
  error,
}: OutputPanelProps) {
  return (
    <div style={panelStyle}>
      <div style={lineStyle}>
        <span style={promptStyle}>{">"}</span>
        {value === null
          ? <span style={placeholderStyle}>{placeholder}</span>
          : <span style={valueStyle}>{value}</span>}
      </div>
      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
}

const mono =
  '"SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const panelStyle: React.CSSProperties = {
  background: "#1d1d1f",
  color: "#f5f5f7",
  borderRadius: 6,
  padding: "8px 14px",
};

const lineStyle: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 13,
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
};

const promptStyle: React.CSSProperties = {
  color: "#8e8e93",
  userSelect: "none",
};

const placeholderStyle: React.CSSProperties = {
  color: "#8e8e93",
  fontStyle: "italic",
};

const valueStyle: React.CSSProperties = {
  color: "#a3e9a4",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const errorStyle: React.CSSProperties = {
  marginTop: 6,
  fontFamily: mono,
  fontSize: 12,
  color: "#ff6961",
};

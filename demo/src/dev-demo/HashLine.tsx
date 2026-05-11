import React from "react";
import type { Hash } from "scaffold.io/util/Hash.ts";

interface HashLineProps {
  hash: Hash | null;
  placeholder?: string;
  onClick?: (hash: Hash) => void;
}

export function HashLine({
  hash,
  placeholder = "Run to populate",
  onClick,
}: HashLineProps) {
  if (!hash) {
    return (
      <div style={lineStyle}>
        <span style={promptStyle}>{">"}</span>
        <span style={placeholderStyle}>{placeholder}</span>
      </div>
    );
  }

  const hex = hash.toHex();
  const display = `0x${hex.slice(0, 16)}…`;

  return (
    <div style={lineStyle}>
      <span style={promptStyle}>{">"}</span>
      <button
        type="button"
        onClick={() => onClick?.(hash)}
        title={hex}
        style={hashBtnStyle}
      >
        {display}
      </button>
    </div>
  );
}

const mono =
  '"SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const lineStyle: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 13,
  padding: "8px 14px",
  background: "#1d1d1f",
  color: "#f5f5f7",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
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

const hashBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#5ac8fa",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: "3px",
};

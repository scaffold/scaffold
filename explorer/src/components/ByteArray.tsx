import React from "react";

interface ByteArrayProps {
  bytes: Uint8Array;
  /** Number of hex chars to show. Default 8. */
  chars?: number;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export const ByteArray = React.memo(
  function ByteArray({ bytes, chars = 8 }: ByteArrayProps) {
    if (bytes.length === 0) {
      return <span className="byte-array byte-array-empty">empty</span>;
    }

    const hex = toHex(bytes);
    const truncated = hex.length > chars;

    return (
      <span className="byte-array" title={hex}>
        {hex.slice(0, chars)}
        {truncated && "\u2026"}
      </span>
    );
  },
);

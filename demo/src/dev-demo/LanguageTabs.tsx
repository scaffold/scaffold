import React from "react";
import { type Lang, LANGUAGES } from "./examples/index.ts";

interface LanguageTabsProps {
  current: Lang;
  onChange: (lang: Lang) => void;
}

export function LanguageTabs({ current, onChange }: LanguageTabsProps) {
  return (
    <div style={tabsStyle} role="tablist" aria-label="Languages">
      {LANGUAGES.map((lang) => {
        const active = lang.id === current;
        return (
          <button
            key={lang.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !active && onChange(lang.id)}
            style={active ? tabActiveStyle : tabStyle}
          >
            {lang.label}
          </button>
        );
      })}
    </div>
  );
}

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const tabsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 2,
  padding: "8px 16px 0",
  borderBottom: "1px solid #d2d2d7",
  background: "#fafafa",
};

const tabStyle: React.CSSProperties = {
  padding: "8px 14px",
  border: "none",
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: "#1d1d1f",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: font,
  marginBottom: -1,
};

const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  borderBottom: "2px solid #0071e3",
  color: "#0071e3",
  cursor: "default",
};

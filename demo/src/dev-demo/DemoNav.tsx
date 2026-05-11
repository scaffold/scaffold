import React from "react";

export type DemoRoute = "explorer" | "chess" | "dev-demo";

interface DemoNavProps {
  route: DemoRoute;
  navigate: (route: DemoRoute) => void;
}

interface NavItem {
  id: DemoRoute;
  label: string;
}

const ITEMS: NavItem[] = [
  { id: "explorer", label: "Sandbox" },
  { id: "chess", label: "Chess" },
  { id: "dev-demo", label: "Dev Demo" },
];

export function DemoNav({ route, navigate }: DemoNavProps) {
  return (
    <div style={segStyle} role="tablist" aria-label="Demos">
      {ITEMS.map((item) => {
        const active = item.id === route;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !active && navigate(item.id)}
            style={active ? segBtnActive : segBtn}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const segStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "#f5f5f7",
  border: "1px solid #d2d2d7",
  borderRadius: 8,
  padding: 2,
  gap: 2,
};

const segBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  color: "#1d1d1f",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: font,
  lineHeight: "18px",
};

const segBtnActive: React.CSSProperties = {
  ...segBtn,
  background: "#fff",
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  cursor: "default",
  color: "#0071e3",
};

import React, { useCallback, useMemo, useState } from "react";
import { BlockCreationModal, BlockGraphExplorer } from "@scaffold/explorer";
import type { InitialClaim } from "@scaffold/explorer";
import { YamlEditorField } from "./YamlEditorField.tsx";
import { Scaffold } from "scaffold.io/Scaffold.ts";
import { Hash } from "scaffold.io/util/Hash.ts";
import { WELL_KNOWN_PRIVATE_KEY } from "scaffold.io/genesis.ts";
import type { Strategy } from "scaffold.io/node/ReactiveLayer.ts";
import { SamplingStrategy } from "scaffold.io/node/strategies/SamplingStrategy.ts";
import { DisputeStrategy } from "scaffold.io/node/strategies/DisputeStrategy.ts";
import { installDebugAPI } from "scaffold.io/debug/ScaffoldDebug.ts";
import yaml from "yaml";
import { ChessApp } from "./chess/ChessApp.tsx";

interface StrategyDef {
  key: string;
  label: string;
  description: string;
  create: () => Strategy;
}

const STRATEGIES: StrategyDef[] = [
  {
    key: "sampling",
    label: "Sampling",
    description: "Verify blocks by priority",
    create: () => new SamplingStrategy(),
  },
  {
    key: "dispute",
    label: "Dispute",
    description: "Dispute invalid blocks",
    create: () => new DisputeStrategy(),
  },
];

type Route = "explorer" | "chess";

export function App() {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return globalThis.location.hash === "#chess" ? "chess" : "explorer";
    }
    return "explorer";
  });

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    if (typeof globalThis !== "undefined" && globalThis.location) {
      globalThis.location.hash = r === "chess" ? "#chess" : "";
    }
  }, []);

  if (route === "chess") {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
        <div style={toolbarStyle}>
          <span style={logoStyle}>Scaffold</span>
          <span style={dividerStyle} />
          <button onClick={() => navigate("explorer")} style={btnSecondary}>
            Explorer
          </button>
          <span style={{ ...hintStyle, marginLeft: 8 }}>
            Chess demo - each move is a block, verified by the game-state
            contract.
          </span>
        </div>
        <ChessApp />
      </div>
    );
  }

  return <ExplorerApp onNavigateChess={() => navigate("chess")} />;
}

interface ExplorerAppProps {
  onNavigateChess: () => void;
}

function ExplorerApp({ onNavigateChess }: ExplorerAppProps) {
  const [enabledStrategies, setEnabledStrategies] = useState<Set<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [version, setVersion] = useState(0);

  const scaffold = useMemo(() => {
    const strategies = STRATEGIES
      .filter((s) => enabledStrategies.has(s.key))
      .map((s) => s.create());
    const s = new Scaffold({
      privateKey: WELL_KNOWN_PRIVATE_KEY,
      strategies,
    });
    installDebugAPI(s);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const [count, setCount] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [initialClaims, setInitialClaims] = useState<InitialClaim[] | undefined>();

  const handleOpenCreateModal = useCallback((claims?: InitialClaim[]) => {
    setInitialClaims(claims);
    setShowCreateModal(true);
  }, []);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setInitialClaims(undefined);
  }, []);

  const parseYaml = useCallback((text: string): Record<string, unknown> | null => {
    try {
      return yaml.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, []);

  const handleAddBlock = useCallback(() => {
    scaffold.put({
      outputs: [
        {
          verifier: {
            contract: Hash.digest("demo-contract"),
            params: new Uint8Array(0),
          },
          value: Math.floor(Math.random() * 100),
          data: new TextEncoder().encode(`block-${Date.now()}`),
        },
      ],
    });
    setCount((c) => c + 1);
  }, [scaffold]);

  const handleAdd5 = useCallback(() => {
    // Pin anchor so all 5 blocks share it (simulates concurrent peers).
    const anchor = scaffold.put({
      outputs: [
        {
          verifier: {
            contract: Hash.digest("demo-contract"),
            params: new Uint8Array(0),
          },
          value: Math.floor(Math.random() * 100),
          data: new TextEncoder().encode(`block-${Date.now()}-0`),
        },
      ],
    }).hash;

    for (let i = 1; i < 5; i++) {
      scaffold.put({
        anchor,
        outputs: [
          {
            verifier: {
              contract: Hash.digest("demo-contract"),
              params: new Uint8Array(0),
            },
            value: Math.floor(Math.random() * 100),
            data: new TextEncoder().encode(`block-${Date.now()}-${i}`),
          },
        ],
      });
    }
    setCount((c) => c + 5);
  }, [scaffold]);

  const toggle = useCallback((key: string) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const dirty = pending.size !== enabledStrategies.size ||
    [...pending].some((k) => !enabledStrategies.has(k));

  const handleRestart = useCallback(() => {
    setEnabledStrategies(new Set(pending));
    setCount(0);
    setVersion((v) => v + 1);
  }, [pending]);

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        <span style={logoStyle}>Scaffold</span>
        <span style={dividerStyle} />
        <button onClick={handleAddBlock} style={btnPrimary}>
          Add Block
        </button>
        <button onClick={handleAdd5} style={btnSecondary}>
          Add 5
        </button>
        <button onClick={() => handleOpenCreateModal()} style={btnSecondary}>
          Create Block
        </button>
        <span style={hintStyle}>
          {count > 0 ? `+${count} added` : "Click to add blocks"}
        </span>

        <span style={dividerStyle} />

        {STRATEGIES.map((s) => (
          <label key={s.key} style={checkStyle} title={s.description}>
            <input
              type="checkbox"
              checked={pending.has(s.key)}
              onChange={() =>
                toggle(s.key)}
              style={{ accentColor: "#0071e3", width: 14, height: 14 }}
            />
            <span style={{ fontSize: 13, fontWeight: 500, color: "#1d1d1f" }}>
              {s.label}
            </span>
          </label>
        ))}

        <button
          onClick={handleRestart}
          style={dirty ? btnPrimary : btnSecondary}
        >
          {dirty ? "Restart" : "Restart"}
        </button>

        <span style={dividerStyle} />
        <button onClick={onNavigateChess} style={btnSecondary}>
          Chess Demo
        </button>
      </div>

      <BlockGraphExplorer scaffold={scaffold} onCreateBlock={handleOpenCreateModal} />

      {showCreateModal && (
        <BlockCreationModal
          scaffold={scaffold}
          initialClaims={initialClaims}
          onClose={handleCloseCreateModal}
          parseYaml={parseYaml}
          renderYamlEditor={(props) => (
            <YamlEditorField
              value={props.value}
              onChange={props.onChange}
              schema={props.schema}
            />
          )}
        />
      )}
    </div>
  );
}

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const toolbarStyle: React.CSSProperties = {
  padding: "10px 24px",
  background: "rgba(255, 255, 255, 0.72)",
  backdropFilter: "saturate(180%) blur(20px)",
  WebkitBackdropFilter: "saturate(180%) blur(20px)",
  borderBottom: "1px solid rgba(0, 0, 0, 0.1)",
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  position: "sticky",
  top: 0,
  zIndex: 50,
};

const logoStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#1d1d1f",
  fontFamily: font,
  letterSpacing: "-0.02em",
};

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 20,
  background: "#d2d2d7",
  margin: "0 4px",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#8e8e93",
  fontFamily: font,
};

const checkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  cursor: "pointer",
  userSelect: "none",
  padding: "5px 8px",
  borderRadius: 8,
  fontFamily: font,
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px",
  background: "#0071e3",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: font,
  transition: "opacity 0.15s",
  lineHeight: "20px",
};

const btnSecondary: React.CSSProperties = {
  ...btnPrimary,
  background: "#f5f5f7",
  color: "#1d1d1f",
  border: "1px solid #d2d2d7",
};

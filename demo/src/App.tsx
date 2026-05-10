import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BlockExplorerOverlay,
  findKey,
  type KeyEntry,
  loadKeys,
  loadSelectedKeyId,
  type SandboxConfig,
  saveSelectedKeyId,
  type StrategyOption,
  WELL_KNOWN_KEY_ID,
} from "@scaffold/explorer";
import { YamlEditorField } from "./YamlEditorField.tsx";
import { Scaffold, type ScaffoldConfig } from "scaffold.io/Scaffold.ts";
import { Hash } from "scaffold.io/util/Hash.ts";
import type { Strategy } from "scaffold.io/node/ReactiveLayer.ts";
import { SamplingStrategy } from "scaffold.io/node/strategies/SamplingStrategy.ts";
import { DisputeStrategy } from "scaffold.io/node/strategies/DisputeStrategy.ts";
import { installDebugAPI } from "scaffold.io/debug/ScaffoldDebug.ts";
import { composeGenesisPacket } from "scaffold.io/core/Block.ts";
import { makeSignatureOutput } from "scaffold.io/contracts/SignatureContract.ts";
import yaml from "yaml";
import { ChessApp } from "./chess/ChessApp.tsx";

interface StrategyDef extends StrategyOption {
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

interface ParsedHash {
  route: Route;
  params: URLSearchParams;
}

function parseHash(hash: string): ParsedHash {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIdx = trimmed.indexOf("?");
  const path = qIdx === -1 ? trimmed : trimmed.slice(0, qIdx);
  const query = qIdx === -1 ? "" : trimmed.slice(qIdx + 1);
  const route: Route = path === "chess" ? "chess" : "explorer";
  return { route, params: new URLSearchParams(query) };
}

function buildHash(route: Route, params: URLSearchParams): string {
  const path = route === "chess" ? "chess" : "";
  const q = params.toString();
  if (!path && !q) return "";
  if (!q) return `#${path}`;
  return `#${path}?${q}`;
}

function readHashParam(name: string): string | null {
  if (typeof globalThis === "undefined" || !globalThis.location) return null;
  return parseHash(globalThis.location.hash).params.get(name);
}

function writeHashParam(name: string, value: string | null) {
  if (typeof globalThis === "undefined" || !globalThis.location) return;
  const { route, params } = parseHash(globalThis.location.hash);
  if (value === null) params.delete(name);
  else params.set(name, value);
  const next = buildHash(route, params);
  if (next === globalThis.location.hash) return;
  globalThis.location.hash = next;
}

function parseYaml(text: string): Record<string, unknown> | null {
  try {
    return yaml.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function renderYamlEditor(
  props: { value: string; onChange: (v: string) => void; schema?: unknown },
) {
  return (
    <YamlEditorField
      value={props.value}
      onChange={props.onChange}
      schema={props.schema as never}
    />
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof globalThis !== "undefined" && globalThis.location) {
      return parseHash(globalThis.location.hash).route;
    }
    return "explorer";
  });

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    if (typeof globalThis !== "undefined" && globalThis.location) {
      const { params } = parseHash(globalThis.location.hash);
      globalThis.location.hash = buildHash(r, params);
    }
  }, []);

  if (route === "chess") {
    return <ChessRoute onNavigateExplorer={() => navigate("explorer")} />;
  }
  return <ExplorerRoute onNavigateChess={() => navigate("chess")} />;
}

// -- Chess route ----------------------------------------------------------

interface ChessRouteProps {
  onNavigateExplorer: () => void;
}

function ChessRoute({ onNavigateExplorer }: ChessRouteProps) {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
      <div style={toolbarStyle}>
        <span style={logoStyle}>Scaffold</span>
        <span style={dividerStyle} />
        <button onClick={onNavigateExplorer} style={btnSecondary}>
          Sandbox
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

// -- Explorer (sandbox) route --------------------------------------------

interface ExplorerRouteProps {
  onNavigateChess: () => void;
}

const SANDBOX_CONFIG_STORAGE = "scaffold-demo-sandbox-config-v1";

interface PersistedSandbox {
  selectedKeyId: string | null;
  strategies: string[];
  enablePiggyback: boolean;
  enableLogging: boolean;
  useFloodGossip: boolean;
  enablePlugins: boolean;
  enableGenerationMode: SandboxConfig["enableGenerationMode"];
  enableVerificationMode: SandboxConfig["enableVerificationMode"];
}

function defaultSandboxConfig(): SandboxConfig {
  return {
    selectedKeyId: WELL_KNOWN_KEY_ID,
    strategies: new Set(),
    enablePiggyback: true,
    enableLogging: true,
    useFloodGossip: false,
    enablePlugins: false,
    enableGenerationMode: "all",
    enableVerificationMode: "all",
  };
}

function loadSandboxConfig(): SandboxConfig {
  const base = defaultSandboxConfig();
  try {
    const raw = globalThis.localStorage?.getItem(SANDBOX_CONFIG_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSandbox>;
      if (parsed.selectedKeyId) base.selectedKeyId = parsed.selectedKeyId;
      if (Array.isArray(parsed.strategies)) {
        base.strategies = new Set(parsed.strategies);
      }
      if (typeof parsed.enablePiggyback === "boolean") {
        base.enablePiggyback = parsed.enablePiggyback;
      }
      if (typeof parsed.enableLogging === "boolean") {
        base.enableLogging = parsed.enableLogging;
      }
      if (typeof parsed.useFloodGossip === "boolean") {
        base.useFloodGossip = parsed.useFloodGossip;
      }
      if (typeof parsed.enablePlugins === "boolean") {
        base.enablePlugins = parsed.enablePlugins;
      }
      if (parsed.enableGenerationMode) {
        base.enableGenerationMode = parsed.enableGenerationMode;
      }
      if (parsed.enableVerificationMode) {
        base.enableVerificationMode = parsed.enableVerificationMode;
      }
    }
  } catch {
    // fall back to defaults
  }
  // URL ?key=<hex> overrides the persisted selection if it matches a stored key.
  const urlKeyId = readHashParam("key");
  if (urlKeyId) {
    const known = findKey(loadKeys(), urlKeyId);
    if (known) {
      base.selectedKeyId = known.id;
      return base;
    }
  }
  const stored = loadSelectedKeyId();
  if (stored && findKey(loadKeys(), stored)) {
    base.selectedKeyId = stored;
  }
  return base;
}

function persistSandboxConfig(config: SandboxConfig) {
  try {
    const data: PersistedSandbox = {
      selectedKeyId: config.selectedKeyId,
      strategies: [...config.strategies],
      enablePiggyback: config.enablePiggyback,
      enableLogging: config.enableLogging,
      useFloodGossip: config.useFloodGossip,
      enablePlugins: config.enablePlugins,
      enableGenerationMode: config.enableGenerationMode,
      enableVerificationMode: config.enableVerificationMode,
    };
    globalThis.localStorage?.setItem(
      SANDBOX_CONFIG_STORAGE,
      JSON.stringify(data),
    );
  } catch {
    // noop
  }
}

function buildScaffoldConfig(
  config: SandboxConfig,
  keys: KeyEntry[],
): { scaffoldConfig: ScaffoldConfig; keyEntry: KeyEntry } {
  const keyEntry = findKey(keys, config.selectedKeyId) ?? keys[0];
  const strategies = STRATEGIES
    .filter((s) => config.strategies.has(s.key))
    .map((s) => s.create());
  // Build a genesis that funds every key in the keystore. autoBalance
  // pulls the active key's signature UTXO out of the genesis to cover
  // the throughput of every put -- without an output for the active
  // key, every "Add Block" attempt fails with "throughput imbalance".
  // Outputs are emitted in keystore order; keys.id is a stable hash of
  // the private key, so any node loading the same keystore computes the
  // same genesis hash.
  const genesis = composeGenesisPacket(
    keys.map((k) => makeSignatureOutput(k.publicKey, 1_000_000)),
  );
  const scaffoldConfig: ScaffoldConfig = {
    privateKey: keyEntry.privateKey,
    genesis,
    strategies,
    enablePiggyback: config.enablePiggyback,
    enableLogging: config.enableLogging,
    useFloodGossip: config.useFloodGossip,
  };
  if (config.enableGenerationMode === "none") {
    scaffoldConfig.enableGeneration = () => false;
  }
  if (config.enableVerificationMode === "none") {
    scaffoldConfig.enableVerification = () => false;
  }
  return { scaffoldConfig, keyEntry };
}

function ExplorerRoute({ onNavigateChess }: ExplorerRouteProps) {
  const [config, setConfig] = useState<SandboxConfig>(() => loadSandboxConfig());
  const [version, setVersion] = useState(0);

  const { scaffold, activeKey } = useMemo(() => {
    const keys = loadKeys();
    const { scaffoldConfig, keyEntry } = buildScaffoldConfig(config, keys);
    const s = new Scaffold(scaffoldConfig);
    installDebugAPI(s);
    return { scaffold: s, activeKey: keyEntry };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Mirror the active key id into the URL (drop the param when it's the
  // well-known default to keep URLs clean).
  useEffect(() => {
    const target = activeKey.id === WELL_KNOWN_KEY_ID ? null : activeKey.id;
    writeHashParam("key", target);
    saveSelectedKeyId(activeKey.id);
  }, [activeKey.id]);

  const [count, setCount] = useState(0);

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

  const handleApplyConfig = useCallback((next: SandboxConfig) => {
    persistSandboxConfig(next);
    saveSelectedKeyId(next.selectedKeyId);
    setConfig(next);
    setCount(0);
    setVersion((v) => v + 1);
  }, []);

  const overlayActions = (
    <>
      <button onClick={handleAddBlock} style={btnPrimary}>
        Add Block
      </button>
      <button onClick={handleAdd5} style={btnSecondary}>
        Add 5
      </button>
      {count > 0 && (
        <span style={{ ...hintStyle, marginRight: 4 }}>+{count} added</span>
      )}
      <span style={dividerStyle} />
      <button onClick={onNavigateChess} style={btnSecondary}>
        Chess Demo
      </button>
    </>
  );

  const strategyOptions: StrategyOption[] = STRATEGIES.map(
    ({ key, label, description }) => ({ key, label, description }),
  );

  return (
    <BlockExplorerOverlay
      key={version}
      scaffold={scaffold}
      defaultMode="fullscreen"
      dismissable={false}
      actions={overlayActions}
      parseYaml={parseYaml}
      renderYamlEditor={renderYamlEditor}
      configPanel={{
        current: config,
        strategyOptions,
        activeKeyLabel: activeKey.label,
        onApply: handleApplyConfig,
      }}
    />
  );
}

// -- Styles ----------------------------------------------------------------

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

const btnPrimary: React.CSSProperties = {
  padding: "5px 12px",
  background: "#0071e3",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 12,
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

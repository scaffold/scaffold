import React, { useCallback, useReducer } from "react";
import type { ReactNode } from "react";
import type { Scaffold } from "scaffold.io/Scaffold.ts";
import { Hash } from "scaffold.io/util/Hash.ts";
import type { Output } from "scaffold.io/core/BlockCreationModule.ts";
import { RecordingReader } from "scaffold.io/core/RecordingReader.ts";
import {
  getContract,
  getContractName,
  getWellKnownContracts,
} from "../contracts.ts";
import {
  descriptorToJsonSchema,
  fieldsToDefaultObject,
  yamlToBuilderValues,
} from "../schemaFromDescriptors.ts";

// -- Public types -----------------------------------------------------------

export interface YamlEditorProps {
  value: string;
  onChange: (yaml: string) => void;
  schema: object;
}

export interface InitialClaim {
  blockHash: Hash;
  outputIndex: number;
  output: Output;
  extendedIndex: number;
}

export interface BlockCreationModalProps {
  scaffold: Scaffold;
  initialClaims?: InitialClaim[];
  onClose: () => void;
  renderYamlEditor: (props: YamlEditorProps) => ReactNode;
  parseYaml: (text: string) => Record<string, unknown> | null;
}

// -- Internal state ---------------------------------------------------------

interface OutputEntry {
  id: string;
  contractHash: Hash | null;
  paramsYaml: string;
  paramsSchema: object;
  dataYaml: string;
  dataSchema: object;
  value: number;
  selfClaim: boolean;
}

interface ClaimEntry {
  blockHash: Hash;
  outputIndex: number;
  output: Output;
  extendedIndex: number;
  value: number;
}

interface ModalState {
  outputs: OutputEntry[];
  claims: ClaimEntry[];
}

// -- Reducer ----------------------------------------------------------------

type ModalAction =
  | { type: "ADD_OUTPUT" }
  | { type: "REMOVE_OUTPUT"; id: string }
  | { type: "UPDATE_OUTPUT"; id: string; patch: Partial<OutputEntry> }
  | {
    type: "SET_CONTRACT";
    id: string;
    contractHash: Hash | null;
    paramsYaml: string;
    paramsSchema: object;
    dataYaml: string;
    dataSchema: object;
  }
  | { type: "ADD_CLAIM"; claim: ClaimEntry }
  | { type: "REMOVE_CLAIM"; extendedIndex: number };

function emptyOutput(): OutputEntry {
  return {
    id: crypto.randomUUID(),
    contractHash: null,
    paramsYaml: "",
    paramsSchema: {},
    dataYaml: "",
    dataSchema: {},
    value: 0,
    selfClaim: false,
  };
}

function reducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case "ADD_OUTPUT":
      return { ...state, outputs: [...state.outputs, emptyOutput()] };

    case "REMOVE_OUTPUT":
      return {
        ...state,
        outputs: state.outputs.filter((o) => o.id !== action.id),
      };

    case "UPDATE_OUTPUT":
      return {
        ...state,
        outputs: state.outputs.map((o) =>
          o.id === action.id ? { ...o, ...action.patch } : o
        ),
      };

    case "SET_CONTRACT":
      return {
        ...state,
        outputs: state.outputs.map((o) =>
          o.id === action.id
            ? {
              ...o,
              contractHash: action.contractHash,
              paramsYaml: action.paramsYaml,
              paramsSchema: action.paramsSchema,
              dataYaml: action.dataYaml,
              dataSchema: action.dataSchema,
            }
            : o
        ),
      };

    case "ADD_CLAIM":
      return { ...state, claims: [...state.claims, action.claim] };

    case "REMOVE_CLAIM":
      return {
        ...state,
        claims: state.claims.filter((c) =>
          c.extendedIndex !== action.extendedIndex
        ),
      };

    default:
      return state;
  }
}

// -- Schema discovery -------------------------------------------------------

interface SchemaResult {
  schema: object;
  defaultYaml: string;
}

const EMPTY_SCHEMA: SchemaResult = { schema: {}, defaultYaml: "" };

async function discoverSchema(
  contractHash: Hash,
  field: "params" | "data",
  userValues?: Map<string, unknown>,
): Promise<SchemaResult> {
  const contract = getContract(contractHash);
  const buildFn = field === "params"
    ? contract?.buildParams
    : contract?.buildData;
  if (!buildFn) return EMPTY_SCHEMA;

  // The builder reads from a RecordingReader (the Reader-interface replacement
  // for DefaultBuilderHost); it records each requested field for the schema and
  // supplies user values / defaults. Builders are async (MaybePromise<Uint8Array>).
  const recorder = new RecordingReader(userValues);
  await buildFn.call(contract, recorder.reader);
  const fields = recorder.getFields();
  const schema = descriptorToJsonSchema(fields);
  const defaultObj = fieldsToDefaultObject(fields);
  const defaultYaml = JSON.stringify(defaultObj, null, 2);
  return { schema, defaultYaml };
}

// -- Component --------------------------------------------------------------

export function BlockCreationModal(
  { scaffold, initialClaims, onClose, renderYamlEditor, parseYaml }:
    BlockCreationModalProps,
) {
  const initialState: ModalState = {
    outputs: [emptyOutput()],
    claims: (initialClaims ?? []).map((c) => ({
      blockHash: c.blockHash,
      outputIndex: c.outputIndex,
      output: c.output,
      extendedIndex: c.extendedIndex,
      value: c.output.value,
    })),
  };

  const [state, dispatch] = useReducer(reducer, initialState);

  const handleContractChange = useCallback(
    async (outputId: string, hashHex: string) => {
      if (!hashHex) {
        dispatch({
          type: "SET_CONTRACT",
          id: outputId,
          contractHash: null,
          paramsYaml: "",
          paramsSchema: {},
          dataYaml: "",
          dataSchema: {},
        });
        return;
      }

      const contractHash = Hash.fromHex(hashHex);
      const params = await discoverSchema(contractHash, "params");
      const data = await discoverSchema(contractHash, "data");

      dispatch({
        type: "SET_CONTRACT",
        id: outputId,
        contractHash,
        paramsYaml: params.defaultYaml,
        paramsSchema: params.schema,
        dataYaml: data.defaultYaml,
        dataSchema: data.schema,
      });
    },
    [],
  );

  const handleParamsChange = useCallback(
    async (outputId: string, contractHash: Hash, yaml: string) => {
      const parsed = parseYaml(yaml);
      if (parsed && contractHash) {
        const contract = getContract(contractHash);
        if (contract?.buildParams) {
          const recorder = new RecordingReader();
          await contract.buildParams(recorder.reader);
          const fields = recorder.getFields();
          const userValues = yamlToBuilderValues(parsed, fields);

          // Re-run builder with user values to discover dynamic schema
          const refreshed = await discoverSchema(contractHash, "params", userValues);
          dispatch({
            type: "UPDATE_OUTPUT",
            id: outputId,
            patch: { paramsYaml: yaml, paramsSchema: refreshed.schema },
          });
          return;
        }
      }
      dispatch({
        type: "UPDATE_OUTPUT",
        id: outputId,
        patch: { paramsYaml: yaml },
      });
    },
    [parseYaml],
  );

  const handleDataChange = useCallback(
    async (outputId: string, contractHash: Hash, yaml: string) => {
      const parsed = parseYaml(yaml);
      if (parsed && contractHash) {
        const contract = getContract(contractHash);
        if (contract?.buildData) {
          const recorder = new RecordingReader();
          await contract.buildData(recorder.reader);
          const fields = recorder.getFields();
          const userValues = yamlToBuilderValues(parsed, fields);

          const refreshed = await discoverSchema(contractHash, "data", userValues);
          dispatch({
            type: "UPDATE_OUTPUT",
            id: outputId,
            patch: { dataYaml: yaml, dataSchema: refreshed.schema },
          });
          return;
        }
      }
      dispatch({
        type: "UPDATE_OUTPUT",
        id: outputId,
        patch: { dataYaml: yaml },
      });
    },
    [parseYaml],
  );

  const handleSubmit = useCallback(async () => {
    const outputs: Output[] = [];

    for (const entry of state.outputs) {
      if (!entry.contractHash) continue;

      const contract = getContract(entry.contractHash);

      // Build params bytes
      let params = new Uint8Array(0);
      if (contract?.buildParams && entry.paramsYaml) {
        const parsed = parseYaml(entry.paramsYaml);
        if (parsed) {
          const discovery = new RecordingReader();
          await contract.buildParams(discovery.reader);
          const fields = discovery.getFields();
          const userValues = yamlToBuilderValues(parsed, fields);
          const builder = new RecordingReader(userValues);
          params = new Uint8Array(await contract.buildParams(builder.reader));
        }
      }

      // Build data bytes
      let data = new Uint8Array(0);
      if (contract?.buildData && entry.dataYaml) {
        const parsed = parseYaml(entry.dataYaml);
        if (parsed) {
          const discovery = new RecordingReader();
          await contract.buildData(discovery.reader);
          const fields = discovery.getFields();
          const userValues = yamlToBuilderValues(parsed, fields);
          const builder = new RecordingReader(userValues);
          data = new Uint8Array(await contract.buildData(builder.reader));
        }
      }

      outputs.push({
        verifier: { contract: entry.contractHash, params },
        value: entry.value,
        data,
      });
    }

    if (outputs.length === 0) return;

    scaffold.put({ outputs });
    onClose();
  }, [state.outputs, parseYaml, scaffold, onClose]);

  const claimTotal = state.claims.reduce((sum, c) => sum + c.value, 0);
  const outputTotal = state.outputs.reduce((sum, o) => sum + o.value, 0);
  const wellKnown = getWellKnownContracts();

  return (
    <div className="block-creation-backdrop" onClick={onClose}>
      <div
        className="block-creation-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="block-creation-header">
          <span className="block-creation-title">Create Block</span>
          <button className="graph-detail-close" onClick={onClose}>×</button>
        </div>

        {/* Claims section */}
        <div className="block-creation-section">
          <div className="block-creation-section-label">
            Claims ({state.claims.length})
          </div>
          {state.claims.length === 0 && (
            <div className="block-creation-empty">No claims added</div>
          )}
          {state.claims.map((claim) => (
            <div
              key={`${claim.blockHash.toHex()}-${claim.extendedIndex}`}
              className="claim-row"
            >
              <span className="claim-contract">
                {getContractName(claim.output.verifier.contract) ??
                  claim.output.verifier.contract.toHex().slice(0, 12) +
                    "\u2026"}
              </span>
              <span className="expanded-hash-chip">
                {claim.blockHash.toHex().slice(0, 12)}&hellip;
              </span>
              <span className="claim-value mono">v={claim.value}</span>
              <button
                className="remove-btn"
                onClick={() =>
                  dispatch({
                    type: "REMOVE_CLAIM",
                    extendedIndex: claim.extendedIndex,
                  })}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {/* Outputs section */}
        <div className="block-creation-section">
          <div className="block-creation-section-label">
            Outputs ({state.outputs.length})
          </div>
          {state.outputs.map((entry) => (
            <div key={entry.id} className="output-card">
              <div className="output-card-header">
                <select
                  className="contract-selector"
                  value={entry.contractHash?.toHex() ?? ""}
                  onChange={(e) =>
                    handleContractChange(entry.id, e.target.value)}
                >
                  <option value="">Select contract...</option>
                  {wellKnown.map((wk) => (
                    <option key={wk.hash.toHex()} value={wk.hash.toHex()}>
                      {wk.name}
                    </option>
                  ))}
                </select>
                <input
                  className="value-input"
                  type="number"
                  min={0}
                  placeholder="Value"
                  value={entry.value}
                  onChange={(e) =>
                    dispatch({
                      type: "UPDATE_OUTPUT",
                      id: entry.id,
                      patch: {
                        value: Math.max(0, parseInt(e.target.value) || 0),
                      },
                    })}
                />
                <button
                  className="remove-btn"
                  onClick={() =>
                    dispatch({ type: "REMOVE_OUTPUT", id: entry.id })}
                >
                  Remove
                </button>
              </div>
              <label className="self-claim-toggle">
                <input
                  type="checkbox"
                  checked={entry.selfClaim}
                  onChange={(e) =>
                    dispatch({
                      type: "UPDATE_OUTPUT",
                      id: entry.id,
                      patch: { selfClaim: e.target.checked },
                    })}
                />
                Self-claim
              </label>

              {/* Params editor */}
              {entry.contractHash && entry.paramsSchema &&
                Object.keys(
                    (entry.paramsSchema as Record<string, unknown>)
                      .properties ?? {},
                  )
                    .length > 0 &&
                (
                  <>
                    <div className="yaml-editor-label">Params</div>
                    {renderYamlEditor({
                      value: entry.paramsYaml,
                      onChange: (yaml) =>
                        handleParamsChange(entry.id, entry.contractHash!, yaml),
                      schema: entry.paramsSchema,
                    })}
                  </>
                )}

              {/* Data editor */}
              {entry.contractHash && entry.dataSchema &&
                Object.keys(
                    (entry.dataSchema as Record<string, unknown>).properties ??
                      {},
                  )
                    .length > 0 &&
                (
                  <>
                    <div className="yaml-editor-label">Data</div>
                    {renderYamlEditor({
                      value: entry.dataYaml,
                      onChange: (yaml) =>
                        handleDataChange(entry.id, entry.contractHash!, yaml),
                      schema: entry.dataSchema,
                    })}
                  </>
                )}
            </div>
          ))}
          <button
            className="add-btn"
            onClick={() => dispatch({ type: "ADD_OUTPUT" })}
          >
            + Add Output
          </button>
        </div>

        {/* Footer */}
        <div className="creation-footer">
          <span className="throughput-indicator">
            Claims: {claimTotal} | Outputs: {outputTotal}
          </span>
          <button className="create-btn" onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export { BlockGraphExplorer } from "./components/BlockGraphExplorer.tsx";
export { BlockExplorerOverlay } from "./components/BlockExplorerOverlay.tsx";
export type {
  BlockExplorerOverlayProps,
  OverlayMode,
} from "./components/BlockExplorerOverlay.tsx";
export { BlockCreationModal } from "./components/BlockCreationModal.tsx";
export type {
  BlockCreationModalProps,
  InitialClaim,
  YamlEditorProps,
} from "./components/BlockCreationModal.tsx";
export { HighlightRegistry } from "./highlight/HighlightRegistry.ts";
export {
  descriptorToJsonSchema,
  fieldsToDefaultObject,
  yamlToBuilderValues,
} from "./schemaFromDescriptors.ts";
export type { Scaffold } from "scaffold.io/Scaffold.ts";
export type { Block } from "scaffold.io/core/Block.ts";
export type { BlockRecordSet } from "scaffold.io/reactive/BlockRecordSet.ts";
import "./styles.css";

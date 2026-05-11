// Side-effect module: registers the global MonacoEnvironment worker dispatch
// and configures @monaco-editor/react to use the bundled monaco-editor.
// Imported by both YamlEditorField and CodeEditorField -- importing it more
// than once is idempotent because the assignment is to a single global.

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import yamlWorker from "monaco-yaml/yaml.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "yaml") return new yamlWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

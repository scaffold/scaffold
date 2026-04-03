import React from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import { configureMonacoYaml, MonacoYaml, MonacoYamlOptions } from 'monaco-yaml';
import * as monaco from 'monaco-editor';
import { editor } from 'monaco-editor';
import yamlWorker from 'monaco-yaml/yaml.worker?worker';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'yaml') return new yamlWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

const createYamlConfig = (schema: object): MonacoYamlOptions => ({
  enableSchemaRequest: true,
  completion: true,
  validate: true,
  format: true,
  hover: true,
  schemas: [
    {
      fileMatch: ['*'],
      schema,
      uri: 'scaffold://block-creation-schema',
    },
  ],
});

interface YamlEditorFieldProps {
  value: string;
  onChange: (yaml: string) => void;
  schema: object;
  height?: string;
  readOnly?: boolean;
}

export const YamlEditorField = ({
  value,
  onChange,
  schema,
  height = '10rem',
  readOnly = false,
}: YamlEditorFieldProps) => {
  const editorRef = React.useRef<editor.IStandaloneCodeEditor>(undefined);
  const yamlRef = React.useRef<MonacoYaml>(undefined);

  React.useEffect(() => {
    yamlRef.current?.update(createYamlConfig(schema));
  }, [schema]);

  return (
    <MonacoEditor
      height={height}
      language="yaml"
      value={value}
      options={{
        readOnly,
        tabSize: 2,
        lineNumbers: 'off',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        quickSuggestions: { comments: false, strings: true, other: false },
      }}
      beforeMount={(m) => {
        yamlRef.current = configureMonacoYaml(m, createYamlConfig(schema));
      }}
      onMount={(ed) => {
        editorRef.current = ed;
      }}
      onChange={(text) => {
        if (text != null) onChange(text);
      }}
    />
  );
};

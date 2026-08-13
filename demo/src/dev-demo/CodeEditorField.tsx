import React from 'react';
import './monacoSetup.ts';
import MonacoEditor from '@monaco-editor/react';

export interface CodeEditorFieldProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  /** Show line numbers gutter. Default false. */
  lineNumbers?: boolean;
}

export const CodeEditorField = ({
  value,
  language,
  onChange,
  readOnly = false,
  height = '10rem',
  lineNumbers = false,
}: CodeEditorFieldProps) => {
  return (
    <MonacoEditor
      height={height}
      language={language}
      value={value}
      options={{
        readOnly,
        tabSize: 2,
        lineNumbers: lineNumbers ? 'on' : 'off',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        renderLineHighlight: readOnly ? 'none' : 'line',
        quickSuggestions: { comments: false, strings: true, other: false },
      }}
      onChange={(text) => {
        if (text != null && onChange) onChange(text);
      }}
    />
  );
};

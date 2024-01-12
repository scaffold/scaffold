import React from 'react';

// https://highlightjs.org/demo#lang=typescript&v=1&theme=atom-one-dark&code=aW1wb3J0IFNjYWZmb2xkLCB7IGJyb3dzZXJDb25maWcgfSBmcm9tICdodHRwczovL2dpdGh1Yi5jb20vc8c1yglyYXcvbWFpbi9pbmRleC50cyc7Cgpjb25zdCDIJCA9IG5ld8lxKM1uKTsKCsgpLmZldGNoKAogICdkZGE4ZWNmZDIyZWEyYjlmZDY3MGNkNDNjYWRkNTUzZWJmZTM1ZGFjODlhNTU1MmFiMTVmZDFjZjNlY2EyMWJkJywKICBKU09OLnN0cmluZ2lmeSh7IG5hbWU6ICdKb2VsJyB9KcQkKHJlc3BvbnNlKSA9PiDkALlvbGUubG9nKOQAtFRleHREZWNvZGVyKCkuZMUKyjIpLAopOwo%3D

export default (
  { children, code, style }: {
    children?: React.ReactNode;
    code?: string;
    style?: React.CSSProperties;
  },
) => (
  <div
    style={{
      width: 'max-content',
      height: 'max-content',
      background: '#22272E',
      boxShadow: `#8CB3F244 0 20px 50px -10px`,
      borderRadius: 10,
      ...style,
    }}
  >
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: 45,
        background: `#FFFFFF10`,
        paddingInline: 16,
      }}
    >
      <div
        style={{
          width: 13,
          height: 13,
          marginRight: 8,
          borderRadius: '50%',
          backgroundColor: '#FF5F57',
        }}
      >
      </div>
      <div
        style={{
          width: 13,
          height: 13,
          marginRight: 8,
          borderRadius: '50%',
          backgroundColor: '#FEBC2E',
        }}
      >
      </div>
      <div
        style={{
          width: 13,
          height: 13,
          marginRight: 8,
          borderRadius: '50%',
          backgroundColor: '#28C840',
        }}
      >
      </div>
      <div style={{ flexGrow: '1' }}></div>
    </div>

    <pre>
      <code
        className='language-typescript'
        style={{
          fontSize: 14,
          fontFamily: 'monospace',
          padding: '1.5em 1em 1em 1em',
        }}
      >
        {children}
      </code>
    </pre>
  </div>
);

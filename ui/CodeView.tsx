import React from 'react';

export default ({ children }: { children?: React.ReactNode }) => (
  <>
    <div
      style={{
        background: `linear-gradient(225deg, #69EACB, #EACCF8, #6654F1)`,
        padding: 100,
        // pointerEvents: 'none',
        // userSelect: 'none',
      }}
    >
      <div
        style={{
          width: 'max-content',
          height: 'max-content',
          background: '#22272E',
          boxShadow: `#26394D 0px 20px 30px -10px`,
          borderRadius: 10,
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
        <div
          style={{
            padding: 21,
            fontSize: 14,
            color: 'white',
            fontFamily: 'monospace',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  </>
);

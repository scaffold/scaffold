import React from 'react';

export default () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'row',
      alignSelf: 'stretch',
      textAlign: 'center',
      margin: '4rem 0',
      fontWeight: '300',
    }}
  >
    <div style={{ flex: '1', backgroundColor: '#8CB3F2', color: '#080808' }}>
      <h2>The web needs servers.</h2>
      <h3>Right?</h3>
    </div>
    <div style={{ flex: '1' }}>
      <h2>Nope.</h2>
      <h3>We can move it all to the browser.</h3>
    </div>
  </div>
);

// The web needs servers.    Nope.
// Right?                    We can move it all to the browser.

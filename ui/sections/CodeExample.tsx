import React from 'react';
import CodeView from '~/ui/CodeView.tsx';

export default () => (
  <CodeView style={{ margin: 'auto' }}>
    {`
import Scaffold, { browserConfig } from 'https://github.com/scaffold/scaffold/raw/v1.0.0/index.ts';

const scaffold = new Scaffold(browserConfig);

scaffold.fetch(
  'dda8ecfd22ea2b9fd670cd43cadd553ebfe35dac89a5552ab15fd1cf3eca21bd',
  JSON.stringify({ name: 'Joel' }),
  (response) => console.log(new TextDecoder().decode(response)),
);
`.trim()}
  </CodeView>
);

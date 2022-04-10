// I don't know why this is necessary but it is :(
import * as x from './sbl/messages.ts';
console.log(x);

import React, { FC } from 'react';
import ReactDOM from 'react-dom';
import Home from './ui/Home.tsx';

ReactDOM.hydrate(<Home />, document.getElementById('root'));

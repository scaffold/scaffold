// I don't know why this is necessary but it is :(
import * as sblMessages from './sbl/messages.ts';
import WorkQueueUtil from './sbl/util/WorkQueue.ts';
console.log(sblMessages, WorkQueueUtil);

import React, { FC } from 'react';
import ReactDOM from 'react-dom';
import Home from './ui/Home.tsx';

ReactDOM.hydrate(<Home />, document.getElementById('root'));

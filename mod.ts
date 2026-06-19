import { Scaffold } from './src/Scaffold.ts';

// Named export so `import { Scaffold } from 'scaffold.io/core'` (and the
// 'scaffold.io' alias) works; default kept for backwards compatibility.
export { Scaffold };
export default Scaffold;

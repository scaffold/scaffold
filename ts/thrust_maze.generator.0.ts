import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import * as thrustMessages from './thrustMessages.ts';
import SimplexNoise from 'simplex-noise';
import { getOrCreate } from '~/sbl/util/map.ts';
import Hash from '../sbl/util/Hash.ts';

/*
new Function(new TextDecoder().decode(Deno.readFileSync('./server/bootstrap/thrust_maze.generator.0.js')))()({params: new Uint8Array([
  137,  71, 59, 174, 206,  27,  73, 223,
   28, 169, 14, 100,  72, 161,   3,  30,
   20, 116, 46,  30,  54,  29, 169, 159,
  153, 161, 33, 122, 254,  32,  28, 250,
    2,   4
]), emitCorrect: true})
*/

const noiseInstances: Map<string, SimplexNoise> = new Map();

const gen: LocalGenerator = ({ params, emitCorrect }) => {
  // console.log(
  //   thrustMessages.MazeParams.encode({ match: Hash.random(), x: 1n, y: 2n }),
  // );

  if (!emitCorrect) {
    return new TextEncoder().encode('DUPE');
  }

  const { match, x, y } = thrustMessages.MazeParams.decode(params);
  const noise = getOrCreate(
    noiseInstances,
    match.toHex(),
    () => new SimplexNoise(match.toHex()),
  );

  const isWall = noise.noise2D(Number(x) / 10, Number(y) / 10) > 0;

  const cell = isWall ? { MazeCellWall: {} } : { MazeCellEmpty: {} };
  return thrustMessages.MazeAnswer.encode({ cell });
};

export default gen;

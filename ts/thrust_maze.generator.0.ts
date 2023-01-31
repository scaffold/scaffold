import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import * as thrustMessages from './thrustMessages.ts';
import SimplexNoise from 'simplex-noise';
import { getOrCreate } from '~/sbl/util/map.ts';

const noiseInstances: Map<string, SimplexNoise> = new Map();

const gen: LocalGenerator = ({ params, emitCorrect }) => {
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

import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  InputParams: {
    name: 'InputParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
      { name: 'player', type: 'Hash' },
      { name: 'idx', type: 'long' },
    ],
  },
  InputAnswer: {
    name: 'InputAnswer',
    type: 'record',
    fields: [
      { name: 'pressing_fwd', type: 'boolean' },
      { name: 'pressing_bwd', type: 'boolean' },
      { name: 'pressing_left', type: 'boolean' },
      { name: 'pressing_right', type: 'boolean' },
      { name: 'pressing_fire', type: 'boolean' },
    ],
  },
  Vector2d: {
    name: 'Vector2d',
    type: 'record',
    fields: [
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
    ],
  },
  PlayerState: {
    name: 'PlayerState',
    type: 'record',
    fields: [
      { name: 'position', type: 'Vector2d' },
      { name: 'velocity', type: 'Vector2d' },
      { name: 'direction', type: 'Vector2d' },
    ],
  },
  GameParams: {
    name: 'GameParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
      { name: 'idx', type: 'long' },
    ],
  },
  GameAnswer: {
    name: 'GameAnswer',
    type: 'record',
    fields: [
      { name: 'players', type: { type: 'array', items: 'PlayerState' } },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const GameParams = base.makeMsg(registry, 'GameParams');
export type GameParams = MsgType<'GameParams'>;
export const GameAnswer = base.makeMsg(registry, 'GameAnswer');
export type GameAnswer = MsgType<'GameAnswer'>;

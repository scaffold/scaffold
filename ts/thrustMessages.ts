import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  InitParams: {
    name: 'InitParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
    ],
  },
  InitAnswer: {
    name: 'InitAnswer',
    type: 'record',
    fields: [
      { name: 'nonce', type: 'Hash' },
      { name: 'init_time', type: 'long' },
    ],
  },
  MazeParams: {
    name: 'MazeParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
      { name: 'x', type: 'long' },
      { name: 'y', type: 'long' },
    ],
  },
  MazeCellEmpty: { name: 'MazeCellEmpty', type: 'record', fields: [] },
  MazeCellWall: { name: 'MazeCellWall', type: 'record', fields: [] },
  MazeAnswer: {
    name: 'MazeAnswer',
    type: 'record',
    fields: [
      { name: 'cell', type: ['MazeCellEmpty', 'MazeCellWall'] },
    ],
  },
  InputParams: {
    name: 'InputParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
      { name: 'player', type: 'Hash' },
      { name: 'tick', type: 'long' },
    ],
  },
  InputEntry: {
    name: 'InputEntry',
    type: 'record',
    fields: [
      { name: 'pressing_fwd', type: 'boolean' },
      { name: 'pressing_bwd', type: 'boolean' },
      { name: 'pressing_left', type: 'boolean' },
      { name: 'pressing_right', type: 'boolean' },
      { name: 'pressing_fire', type: 'boolean' },
    ],
  },
  InputAnswer: {
    name: 'InputAnswer',
    type: 'record',
    fields: [
      {
        name: 'entry',
        type: ['null', 'InputEntry'],
      },
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
  GameState: {
    name: 'GameState',
    type: 'record',
    fields: [
      { name: 'center', type: 'Vector2d' },
      { name: 'velocity', type: 'Vector2d' },
      { name: 'size', type: 'float' },
    ],
  },
  PlayerState: {
    name: 'PlayerState',
    type: 'record',
    fields: [
      { name: 'hash', type: 'Hash' },
      { name: 'position', type: 'Vector2d' },
      { name: 'velocity', type: 'Vector2d' },
      { name: 'angle_rads', type: 'float' },
      // { name: 'angle_vel_rads', type: 'float' },
    ],
  },
  BulletState: {
    name: 'BulletState',
    type: 'record',
    fields: [
      { name: 'position', type: 'Vector2d' },
      { name: 'velocity', type: 'Vector2d' },
      { name: 'death_tick', type: 'long' },
    ],
  },
  PlayerJoin: {
    name: 'PlayerJoin',
    type: 'record',
    fields: [
      { name: 'player_name', type: 'string' },
      { name: 'color', type: 'int' },
    ],
  },
  GameParams: {
    name: 'GameParams',
    type: 'record',
    fields: [
      { name: 'match', type: 'Hash' },
      { name: 'tick', type: 'long' },
    ],
  },
  GameAnswer: {
    name: 'GameAnswer',
    type: 'record',
    fields: [
      { name: 'game_state', type: 'GameState' },
      { name: 'players', type: { type: 'array', items: 'PlayerState' } },
      { name: 'bullets', type: { type: 'array', items: 'BulletState' } },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const InitParams = base.makeMsg(registry, 'InitParams');
export type InitParams = MsgType<'InitParams'>;
export const InitAnswer = base.makeMsg(registry, 'InitAnswer');
export type InitAnswer = MsgType<'InitAnswer'>;
export const MazeParams = base.makeMsg(registry, 'MazeParams');
export type MazeParams = MsgType<'MazeParams'>;
export const MazeAnswer = base.makeMsg(registry, 'MazeAnswer');
export type MazeAnswer = MsgType<'MazeAnswer'>;
export const InputParams = base.makeMsg(registry, 'InputParams');
export type InputParams = MsgType<'InputParams'>;
export const InputEntry = base.makeMsg(registry, 'InputEntry');
export type InputEntry = MsgType<'InputEntry'>;
export const InputAnswer = base.makeMsg(registry, 'InputAnswer');
export type InputAnswer = MsgType<'InputAnswer'>;
export const GameParams = base.makeMsg(registry, 'GameParams');
export type GameParams = MsgType<'GameParams'>;
export const GameAnswer = base.makeMsg(registry, 'GameAnswer');
export type GameAnswer = MsgType<'GameAnswer'>;

import React from 'react';
import REGL from 'regl';
import { mat4, vec3 } from 'gl-matrix';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import bunny from 'bunny';
import normals from 'angle-normals';

interface Uniforms {}
interface Attributes {}
interface Props {
  model: mat4; // mat4.identity([]),
  eye: vec3;
  target: vec3;
}
interface OwnContext {
  projection: mat4;
  view: mat4;
  eye: vec3;
}

type Context = REGL.DefaultContext & OwnContext;

const initView = (canvas: HTMLCanvasElement) => {
  const regl = REGL(canvas);
  const draw = regl<Uniforms, Attributes, Props, OwnContext>({
    vert: `
    precision mediump float;
    attribute vec3 position;
    uniform mat4 model, view, projection;
    void main() {
      gl_Position = projection * view * model * vec4(position, 1);
    }`,

    frag: `
    precision mediump float;
    void main() {
      gl_FragColor = vec4(1, 0, 0, 1);
    }`,

    attributes: {
      position: bunny.positions,
      normal: normals(bunny.cells, bunny.positions),
    },

    elements: bunny.cells,

    context: {
      projection: ({ viewportWidth, viewportHeight }: Context) =>
        mat4.perspective(
          [],
          Math.PI / 4,
          viewportWidth / viewportHeight,
          0.01,
          1000.0,
        ),

      view: ({}: Context, { eye, target }: Props) =>
        mat4.lookAt([], eye, target, [0, 0, 1]),

      eye: regl.prop<Props, 'eye'>('eye'),
    },

    uniforms: {
      model: regl.prop<Props, 'model'>('model'),
      view: regl.context<Context, 'view'>('view'),
      invView: ({ view }: Context) => mat4.inverse([], view),
      projection: regl.context<Context, 'projection'>('projection'),
    },
    //   attributes: {
    //     freq: {
    //       buffer: pointBuffer,
    //       stride: VERT_SIZE,
    //       offset: 0,
    //     },
    //     phase: {
    //       buffer: pointBuffer,
    //       stride: VERT_SIZE,
    //       offset: 16,
    //     },
    //     color: {
    //       buffer: pointBuffer,
    //       stride: VERT_SIZE,
    //       offset: 32,
    //     },
    //   },

    // uniforms: {
    //   view: ({ tick }) => {
    //     const t = 0.01 * tick;
    //     return mat4.lookAt(
    //       mat4.create(),
    //       [30 * Math.cos(t), 2.5, 30 * Math.sin(t)],
    //       [0, 0, 0],
    //       [0, 1, 0],
    //     );
    //   },
    //   projection: ({ viewportWidth, viewportHeight }) =>
    //     mat4.perspective(
    //       mat4.create(),
    //       Math.PI / 4,
    //       viewportWidth / viewportHeight,
    //       0.01,
    //       1000,
    //     ),
    //   time: ({ tick }) => tick * 0.001,
    // },

    // primitive: 'points',
  });

  regl.frame(({ time }) => {
    // clear contents of the drawing buffer
    regl.clear({
      color: [0, 0, 0, 0],
      depth: 1,
    });

    // draw a triangle using the command defined above

    draw({
      model: mat4.identity([]),
      eye: [1, 0, 10],
      target: [0, 0, 0],
    });
  });
};

export default (
  { state: { game_state, players, bullets } }: {
    state: thrustMessages.GameAnswer;
  },
) => {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    if (canvas.current) {
      console.log('redraw');
      initView(canvas.current);
    }
    return () => {};
  }, [canvas.current]);
  return <canvas width={750} height={500} ref={canvas} />;
};

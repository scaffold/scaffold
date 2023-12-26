import React from 'react';
import REGL from 'regl';
import { mat4, vec2, vec3 } from 'gl-matrix';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import bunny from 'bunny';
import normals from 'angle-normals';
import Hash from '~/sbl/util/Hash.ts';
import SblContext from '~/sbl/Context.ts';
import ThrustProvider from './ThrustProvider.ts';
import VoxelMesher from './VoxelMesher.ts';
import ArenaCellUpdater from './ArenaCellUpdater.ts';
import PromiseSequencer from './PromiseSequencer.ts';

const v2s = (v: vec3) => `${v[0]},${v[1]},${v[2]}`;

// const eyeHeight = 100;
const eyeHeight = 25;
const materials = [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 0, 1, 1]];

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

const initView = (
  // sbl: SblContext,
  provider: ThrustProvider,
  // match: Hash,
  // player: Hash,
  canvas: HTMLCanvasElement,
) => {
  const regl = REGL({
    canvas,
    extensions: [
      'OES_standard_derivatives',
      'OES_element_index_uint',
      'OES_texture_float',
    ],
  });

  (window as any).regl = regl;

  const maze = new VoxelMesher(regl);
  const cellUpdateSequencer = new PromiseSequencer();
  const arenaCellUpdater = new ArenaCellUpdater(
    (x, y) =>
      cellUpdateSequencer.run(
        `${x} ${y}`,
        () =>
          provider.getCell(BigInt(x), BigInt(y)).then((cell) => {
            if ('MazeCellWall' in cell) {
              maze.set(x, y, 0, 1);
            }
          }),
      ),
    (x, y) => cellUpdateSequencer.run(`${x} ${y}`, () => maze.set(x, y, 0, 0)),
  );

  const makeRenderer = (
    override: Partial<REGL.DrawConfig<Uniforms, Attributes, Props, OwnContext>>,
  ) =>
    regl<Uniforms, Attributes, Props, OwnContext>({
      vert: `
      attribute vec3 a_position;
      // attribute vec3 a_normal;
      attribute float a_material;

      uniform mat4 u_modelview, u_projection, u_normal;
      uniform sampler2D u_matColor;

      varying vec3 v_normalInterp;
      varying vec3 v_vertPos;
      varying vec4 v_material;

      void main(){
        const float MATERIAL_TEXTURE_X_FACTOR = 1.0 / ${materials.length}.0;
        vec3 normal = vec3(0.0, 0.0, 0.0);
        vec4 vertPos4 = u_modelview * vec4(a_position, 1.0);
        v_vertPos = vec3(vertPos4) / vertPos4.w;
        v_normalInterp = vec3(u_normal * vec4(normal, 0.0));
        v_material = texture2D(u_matColor, vec2((a_material - 0.5) * MATERIAL_TEXTURE_X_FACTOR, 0.5));
        gl_Position = u_projection * vertPos4;
      }`,

      frag: `
      #extension GL_OES_standard_derivatives : enable

      precision mediump float;
      varying vec3 v_normalInterp;  // Surface normal
      varying vec3 v_vertPos;       // Vertex position
      varying vec4 v_material;
      uniform float Ka;   // Ambient reflection coefficient
      uniform float Kd;   // Diffuse reflection coefficient
      uniform float Ks;   // Specular reflection coefficient
      uniform float shininessVal; // Shininess
      // Material color
      uniform vec3 ambientColor;
      uniform vec3 diffuseColor;
      uniform vec3 specularColor;
      uniform vec3 lightPos; // Light position

      highp float rand(float seed) {
        highp float c = 43758.5453;
        highp float sn = mod(seed, 3.14);
        return fract(sin(sn) * c);
      }

      void main() {
        // dFdx() and dFdy()
        vec3 N = normalize(v_normalInterp);
        vec3 L = normalize(lightPos - v_vertPos);

        // Lambert's cosine law
        float lambertian = max(dot(N, L), 0.0);
        float specular = 0.0;
        if(lambertian > 0.0) {
          vec3 R = reflect(-L, N);      // Reflected light vector
          vec3 V = normalize(-v_vertPos); // Vector to viewer
          // Compute the specular term
          float specAngle = max(dot(R, V), 0.0);
          specular = pow(specAngle, shininessVal);
        }
        gl_FragColor = vec4(Ka * ambientColor +
                            Kd * lambertian * diffuseColor +
                            Ks * specular * specularColor, 1.0);
        gl_FragColor = v_material;
      }`,

      // attributes: {
      //   position: bunny.positions,
      //   normal: normals(bunny.cells, bunny.positions),
      // },
      // elements: bunny.cells,

      // attributes: {
      //   position: [[2, 0, 0], [-2, 1, 0], [-2, -1, 0]],
      //   normal: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
      // },
      // elements: [[0, 1, 2]],

      // cull: {
      //   enable: true,
      //   face: 'back',
      // },

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
        u_modelview: ({ view }: Context, { model }: Props) =>
          mat4.multiply([], view, model),
        u_invView: ({ view }: Context) => mat4.inverse([], view),
        u_normal: ({ view }: Context, { model }: Props) =>
          mat4.transpose([], mat4.invert([], mat4.multiply([], view, model))),
        u_projection: regl.context<Context, 'projection'>('projection'),

        u_matColor: regl.texture({
          data: materials,
          width: materials.length,
          height: 1,
          format: 'rgba',
          type: 'float',
        }),

        Ka: 0.1, // Ambient reflection coefficient
        Kd: 0.5, // Diffuse reflection coefficient
        Ks: 0.1, // Specular reflection coefficient
        shininessVal: 4, // Shininess

        // Material color
        ambientColor: [1, 0, 0],
        diffuseColor: [1, 1, 1],
        specularColor: [1, 1, 1],
        lightPos: [0, 0, 10], // Light position
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

      ...override,
    });

  const drawMaze = makeRenderer({
    attributes: {
      a_position: {
        buffer: () => maze.vertPosBuf,
        offset: 0,
        stride: 3 * 4,
        normalized: false,
      },
      a_material: {
        buffer: () => maze.vertMatBuf,
        offset: 0,
        stride: 1,
        normalized: false,
      },
    },
    elements: () => maze.faceIdxBuf,
    count: () => maze.getElementsCount(),
  });

  const drawPlayer = makeRenderer({
    attributes: {
      a_position: [[2, 0, 0], [-2, 1, 0], [-2, -1, 0]],
      a_material: [1, 1, 1],
    },
    elements: [[0, 1, 2]],
  });

  let eyePos = vec3.fromValues(0, 0, eyeHeight);
  let eyeVel = vec3.create();

  regl.frame(({ time }) => {
    regl.clear({
      color: [0, 0, 0, 0],
      depth: 1,
    });

    const state = provider.getRenderState();

    arenaCellUpdater.setArena(
      Math.round(state.game_state.center.x),
      Math.round(state.game_state.center.y),
      Math.round(state.game_state.size),
    );

    if (state.players.length) {
      const players = state.players.map(
        ({ hash, position, velocity, angle_rads }) => {
          const pos = vec3.fromValues(position.x, position.y, 0);
          const vel = vec3.fromValues(velocity.x, velocity.y, 0);
          return { hash, pos, vel, angle_rads };
        },
      );

      const selfPlayer = players.find(({ hash }) =>
        Hash.equals(hash, provider.player)
      ) ||
        players[Number(provider.getRenderIdx() / 10n) % players.length];

      eyeVel = vec3.scaleAndAdd(
        [],
        eyeVel,
        vec3.sub([], selfPlayer.pos, eyePos),
        0.01,
      );
      eyeVel = vec3.scale([], eyeVel, 0.99);
      eyeVel[2] = 0;
      eyePos = vec3.scaleAndAdd([], eyePos, eyeVel, 0.01);

      const target = vec3.scaleAndAdd(
        [],
        selfPlayer.pos,
        vec3.normalize(
          [],
          vec3.add(
            [],
            selfPlayer.vel,
            vec3.fromValues(
              Math.cos(selfPlayer.angle_rads) * 0.5,
              Math.sin(selfPlayer.angle_rads) * 0.5,
              0,
            ),
          ),
        ),
        6,
      );
      // const target = selfPlayer.pos;
      // const target = vec3.fromValues(
      //   state.game_state.center.x,
      //   state.game_state.center.y,
      //   0,
      // );

      drawMaze({
        model: mat4.fromTranslation([], vec3.fromValues(0, 0, -0.5)),
        eye: eyePos,
        target,
      });

      players.forEach((player) => {
        drawPlayer({
          model: mat4.scale(
            [],
            mat4.rotateZ(
              [],
              mat4.fromTranslation([], player.pos),
              player.angle_rads,
            ),
            [0.1, 0.1, 0.1],
          ),
          eye: eyePos,
          target,
        });
      });
    }
  });

  return {
    release: () => {
      arenaCellUpdater.destruct();
      regl.destroy();
    },
  };
};

export default (
  { sbl, match, player }: { sbl: SblContext; match: Hash; player: Hash },
) => {
  const [provider, setProvider] = React.useState<ThrustProvider>();
  React.useEffect(() => {
    try {
      const provider = new ThrustProvider(sbl, match, player);
      setProvider(provider);
      return () => {
        console.log('destruct provider');
        setProvider(undefined);
        provider.destruct();
      };
    } catch (err) {
      console.error(err);
    }
  }, [sbl, match, player]);

  const [keyPressed, setKeyPressed] = React.useState<boolean>(false);

  React.useEffect(() => {
    console.log('reattach key event listeners');

    const makeKeyHandler = (val: boolean) => (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyI':
          provider?.setFwd(val);
          break;
        case 'KeyK':
          provider?.setBwd(val);
          break;
        case 'KeyJ':
          provider?.setLeft(val);
          break;
        case 'KeyL':
          provider?.setRight(val);
          break;
        case 'KeyF':
          provider?.setFire(val);
          break;
      }
    };

    const onKeyDown = makeKeyHandler(true);
    const onKeyUp = makeKeyHandler(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [provider]);

  const canvas = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    if (provider && canvas.current) {
      console.log('redraw');
      const view = initView(provider, canvas.current);
      return () => {
        view.release();
      };
    }
  }, [provider, canvas.current]);

  return (
    <div>
      <canvas
        width={750}
        height={500}
        ref={canvas}
        style={{ border: '1px solid black' }}
      />
    </div>
  );
};

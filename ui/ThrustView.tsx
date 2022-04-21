import React from 'react';
import REGL from 'regl';
import { mat4, vec3 } from 'gl-matrix';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import bunny from 'bunny';
import normals from 'angle-normals';
import Hash from '~/sbl/util/Hash.ts';
import SblContext from '~/sbl/Context.ts';
import ThrustProvider from './ThrustProvider.ts';
import VoxelMesher from './VoxelMesher.ts';

const v2s = (v: vec3) => `${v[0]},${v[1]},${v[2]}`;

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
  const regl = REGL(canvas);
  const mesher = new VoxelMesher(regl);
  mesher.set(10, 0, 0, true);
  mesher.set(10, 4, 0, true);
  mesher.set(4, 20, 0, true);
  mesher.set(-2, 8, 0, true);
  const draw = regl<Uniforms, Attributes, Props, OwnContext>({
    vert: `
      attribute vec3 position;
      // attribute vec3 normal;
      uniform mat4 modelview, projection, normalMat;
      varying vec3 normalInterp;
      varying vec3 vertPos;

      void main(){
        vec3 normal = vec3(0.0, 0.0, 0.0);
        vec4 vertPos4 = modelview * vec4(position, 1.0);
        vertPos = vec3(vertPos4) / vertPos4.w;
        normalInterp = vec3(normalMat * vec4(normal, 0.0));
        gl_Position = projection * vertPos4;
      }`,

    frag: `
      precision mediump float;
      varying vec3 normalInterp;  // Surface normal
      varying vec3 vertPos;       // Vertex position
      uniform float Ka;   // Ambient reflection coefficient
      uniform float Kd;   // Diffuse reflection coefficient
      uniform float Ks;   // Specular reflection coefficient
      uniform float shininessVal; // Shininess
      // Material color
      uniform vec3 ambientColor;
      uniform vec3 diffuseColor;
      uniform vec3 specularColor;
      uniform vec3 lightPos; // Light position

      void main() {
        vec3 N = normalize(normalInterp);
        vec3 L = normalize(lightPos - vertPos);

        // Lambert's cosine law
        float lambertian = max(dot(N, L), 0.0);
        float specular = 0.0;
        if(lambertian > 0.0) {
          vec3 R = reflect(-L, N);      // Reflected light vector
          vec3 V = normalize(-vertPos); // Vector to viewer
          // Compute the specular term
          float specAngle = max(dot(R, V), 0.0);
          specular = pow(specAngle, shininessVal);
        }
        gl_FragColor = vec4(Ka * ambientColor +
                            Kd * lambertian * diffuseColor +
                            Ks * specular * specularColor, 1.0);
        // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
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

    attributes: {
      position: {
        buffer: () => mesher.vertPosBuf,
        offset: 0,
        stride: 3 * 4,
        normalized: false,
      },
    },
    elements: () => mesher.faceIdxBuf,

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
      modelview: ({ view }: Context, { model }: Props) =>
        mat4.multiply([], view, model),
      invView: ({ view }: Context) => mat4.inverse([], view),
      normalMat: ({ view }: Context, { model }: Props) =>
        mat4.transpose([], mat4.invert([], mat4.multiply([], view, model))),
      projection: regl.context<Context, 'projection'>('projection'),

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
  });

  let eyePos = vec3.fromValues(0, 0, 20);
  let eyeVel = vec3.create();

  regl.frame(({ time }) => {
    regl.clear({
      color: [0, 0, 0, 0],
      depth: 1,
    });

    const state = provider.getRenderState();

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
        0.001,
      );
      eyeVel = vec3.scale([], eyeVel, 0.99);
      eyeVel[2] = 0;
      eyePos = vec3.scaleAndAdd([], eyePos, eyeVel, 0.01);
      eyePos = vec3.fromValues(0, 0, 20);

      // const target = vec3.scaleAndAdd([], selfPlayer.pos, selfPlayer.vel, 10);
      const target = selfPlayer.pos;

      players.forEach((player) => {
        draw({
          model: mat4.rotateZ(
            [],
            mat4.fromTranslation([], player.pos),
            player.angle_rads,
          ),
          eye: eyePos,
          target,
        });
      });
    }
  });

  return {
    release: () => regl.destroy(),
  };
};

export default (
  { sbl, match, player }: { sbl: SblContext; match: Hash; player: Hash },
) => {
  const [provider, setProvider] = React.useState<ThrustProvider>();
  React.useEffect(() => {
    console.log('new provider');
    const provider = new ThrustProvider(sbl, match, player);
    setProvider(provider);
    return () => {
      console.log('destruct provider');
      setProvider(undefined);
      provider.destruct();
    };
  }, [sbl, match, player]);

  const [keyPressed, setKeyPressed] = React.useState<boolean>(false);

  React.useEffect(() => {
    console.log('reattach key event listeners');

    const makeKeyHandler = (val: boolean) =>
      (event: KeyboardEvent) => {
        switch (event.code) {
          case 'ArrowUp':
            provider?.setFwd(val);
            break;
          case 'ArrowDown':
            provider?.setBwd(val);
            break;
          case 'ArrowLeft':
            provider?.setLeft(val);
            break;
          case 'ArrowRight':
            provider?.setRight(val);
            break;
          case 'Space':
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
      <canvas width={750} height={500} ref={canvas} />
    </div>
  );
};

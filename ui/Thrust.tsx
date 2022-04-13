// import * as THREE from 'threejs';
// (() => {
//   const camera = new THREE.PerspectiveCamera(
//     70,
//     window.innerWidth / window.innerHeight,
//     0.01,
//     10,
//   );
//   camera.position.z = 1;

//   const scene = new THREE.Scene();

//   const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
//   const material = new THREE.MeshNormalMaterial();

//   const mesh = new THREE.Mesh(geometry, material);
//   scene.add(mesh);

//   const renderer = new THREE.WebGLRenderer({ antialias: true });
//   renderer.setSize(window.innerWidth, window.innerHeight);
//   renderer.setAnimationLoop(animation);
//   document.body.appendChild(renderer.domElement);

//   function animation(time: number) {
//     mesh.rotation.x = time / 2000;
//     mesh.rotation.y = time / 1000;

//     renderer.render(scene, camera);
//   }
// })();

import REGL from 'regl';
(() => {
  const regl = REGL();

  const NUM_POINTS = 1e4;
  const VERT_SIZE = 4 * (4 + 4 + 3);

  const pointBuffer = regl.buffer(
    Array(NUM_POINTS).fill(undefined).map(function () {
      const color = hsv2rgb(Math.random() * 360, 0.6, 1);
      return [
        // freq
        Math.random() * 10,
        Math.random() * 10,
        Math.random() * 10,
        Math.random() * 10,
        // phase
        2.0 * Math.PI * Math.random(),
        2.0 * Math.PI * Math.random(),
        2.0 * Math.PI * Math.random(),
        2.0 * Math.PI * Math.random(),
        // color
        color[0] / 255,
        color[1] / 255,
        color[2] / 255,
      ];
    }),
  );

  interface Uniforms {
    // time: number;
    // view: REGL.Mat4;
    // projection: REGL.Mat4;
    color: REGL.DynamicVariable<REGL.Vec4>;
  }

  interface Attributes {
    freq: REGL.AttributeConfig;
    phase: REGL.AttributeConfig;
    color: REGL.AttributeConfig;
  }

  const drawTriangle = regl<Uniforms, Attributes>({
    // Shaders in regl are just strings.  You can use glslify or whatever you want
    // to define them.  No need to manually create shader objects.
    frag: `
    precision mediump float;
    uniform vec4 color;
    void main() {
      gl_FragColor = color;
    }`,

    vert: `
    precision mediump float;
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0, 1);
    }`,

    // Here we define the vertex attributes for the above shader
    attributes: {
      freq: {
        buffer: pointBuffer,
        stride: VERT_SIZE,
        offset: 0,
      },
      phase: {
        buffer: pointBuffer,
        stride: VERT_SIZE,
        offset: 16,
      },
      color: {
        buffer: pointBuffer,
        stride: VERT_SIZE,
        offset: 32,
      },
    },

    uniforms: {
      // This defines the color of the triangle to be a dynamic variable
      color: regl.prop('color'),
    },

    // This tells regl the number of vertices to draw in this command
    count: 3,
  });

  // regl.frame() wraps requestAnimationFrame and also handles viewport changes
  regl.frame(({ time }) => {
    // clear contents of the drawing buffer
    regl.clear({
      color: [0, 0, 0, 0],
      depth: 1,
    });

    // draw a triangle using the command defined above
    drawTriangle({
      color: [
        Math.cos(time * 0.001),
        Math.sin(time * 0.0008),
        Math.cos(time * 0.003),
        1,
      ],
    });
  });
})();

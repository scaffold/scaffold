import REGL from 'regl';
import { getOrCreate } from '~/sbl/util/map.ts';

interface Cell {
  material: number;
  face_nx?: number;
  face_px?: number;
  face_ny?: number;
  face_py?: number;
  face_nz?: number;
  face_pz?: number;
}

const makeCellKey = (x: number, y: number, z: number) => `${x} ${y} ${z}`;
const createCell = (): Cell => ({ material: 0 });

const makeVertKey = (x: number, y: number, z: number, material: number) =>
  `${x} ${y} ${z} ${material}`;

const showTriangles = true;
const randomMaterial = () => Math.floor(Math.random() * 2) + 1;

export default class VoxelMesher {
  private cells: Map<string, Cell> = new Map();

  private verts: Map<string, number> = new Map();

  // private vertPoss: [number, number, number][] = [];
  // private vertNorms: [number, number, number][] = [];
  // private faceIdxs: [number, number, number][] = [];

  public vertPosBuf: REGL.Buffer;
  public vertMatBuf: REGL.Buffer;
  public faceIdxBuf: REGL.Elements;

  private vertCount: number;
  private faceCount: number;

  private freeVerts: number[];
  private freeFaces: number[];

  private updateQueue: {}[] = [];

  constructor(regl: REGL.Regl) {
    this.vertCount = 1024 * 1024;
    this.vertPosBuf = regl.buffer({
      data: new Float32Array(new Array(this.vertCount * 3).fill(0)),
      // length: this.vertCount * (3 * 4),
      type: 'float32',
      usage: 'dynamic',
    });
    this.vertMatBuf = regl.buffer({
      data: new Uint8Array(new Array(this.vertCount).fill(0)),
      // length: this.vertCount * (3 * 4),
      type: 'uint8',
      usage: 'dynamic',
    });
    this.freeVerts = [...Array(this.vertCount).keys()].reverse();

    this.faceCount = 1024 * 1024;
    this.faceIdxBuf = regl.elements({
      data: new Uint16Array(new Array(this.faceCount * 6).fill(0)),
      // length: this.faceCount * (6 * 2),
      // count: undefined,
      primitive: 'triangles',
      // type: 'uint32',
      type: 'uint16',
      usage: 'dynamic',
    });
    this.freeFaces = [...Array(this.faceCount).keys()].reverse();

    // this.vertNormBuf({ length: 10 });
    // this.vertNormBuf.subdata([4, 5, 6], 2);
    // this.vertNormBuf.destroy();
  }

  public destruct() {
    this.vertPosBuf.destroy();
    this.vertMatBuf.destroy();
    this.faceIdxBuf.destroy();
  }

  public getElementsCount() {
    return this.faceCount;
  }

  public set(x: number, y: number, z: number, material: number) {
    const centerKey = makeCellKey(x, y, z);
    const c_000 = getOrCreate(this.cells, centerKey, createCell);

    if (c_000.material === material) {
      return;
    }
    c_000.material = material;

    const c_900 = getOrCreate(this.cells, makeCellKey(x - 1, y, z), createCell);
    const c_100 = getOrCreate(this.cells, makeCellKey(x + 1, y, z), createCell);
    const c_090 = getOrCreate(this.cells, makeCellKey(x, y - 1, z), createCell);
    const c_010 = getOrCreate(this.cells, makeCellKey(x, y + 1, z), createCell);
    const c_009 = getOrCreate(this.cells, makeCellKey(x, y, z - 1), createCell);
    const c_001 = getOrCreate(this.cells, makeCellKey(x, y, z + 1), createCell);

    this.updateFaceNx(c_000, c_900, x, y, z);
    this.updateFacePx(c_000, c_100, x, y, z);
    this.updateFaceNy(c_000, c_090, x, y, z);
    this.updateFacePy(c_000, c_010, x, y, z);
    this.updateFaceNz(c_000, c_009, x, y, z);
    this.updateFacePz(c_000, c_001, x, y, z);

    this.updateFacePx(c_900, c_000, x - 1, y, z);
    this.updateFaceNx(c_100, c_000, x + 1, y, z);
    this.updateFacePy(c_090, c_000, x, y - 1, z);
    this.updateFaceNy(c_010, c_000, x, y + 1, z);
    this.updateFacePz(c_009, c_000, x, y, z - 1);
    this.updateFaceNz(c_001, c_000, x, y, z + 1);

    if (
      c_000.material === 0 &&
      c_000.face_nx === undefined &&
      c_000.face_px === undefined &&
      c_000.face_ny === undefined &&
      c_000.face_py === undefined &&
      c_000.face_nz === undefined &&
      c_000.face_pz === undefined
    ) {
      this.cells.delete(centerKey);
    }
  }

  private allocVert(): number {
    if (this.freeVerts.length) {
      return this.freeVerts.pop()!;
    } else {
      // assert(this.vertPoss.length === this.vertNorms.length);
      // const idx = this.vertPoss.length;
      // this.vertPoss.push([NaN, NaN, NaN]);
      // this.vertNorms.push([NaN, NaN, NaN]);
      // return idx;
      throw new Error(`allocVert`);
    }
  }

  private allocFace(): number {
    if (this.freeFaces.length) {
      return this.freeFaces.pop()!;
    } else {
      throw new Error(`allocFace`);
    }
  }

  private getVert(x: number, y: number, z: number, material: number) {
    return getOrCreate(this.verts, makeVertKey(x, y, z, material), () => {
      const vert = this.allocVert();
      this.setVert(vert, [x, y, z], material);
      return vert;
    });
  }

  private setVert(
    idx: number,
    pos: [number, number, number],
    material: number,
  ) {
    // console.log('setVert', idx, pos, material);
    this.vertPosBuf.subdata(pos, idx * (3 * 4));
    this.vertMatBuf.subdata([material], idx);
  }

  private setFace(
    idx: number,
    verts: [number, number, number, number, number, number],
  ) {
    // console.log('setFace', idx, verts);
    this.faceIdxBuf.subdata(verts, idx * (6 * 2));
  }

  private updateFaceNx(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_nx === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_nx = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_nx, [
          this.getVert(innerX + 0, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1, mat_0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0, mat_0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0, mat_1),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_nx);
        this.setFace(inner.face_nx, [0, 0, 0, 0, 0, 0]);
        inner.face_nx = undefined;
      }
    }
  }

  private updateFacePx(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_px === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_px = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_px, [
          this.getVert(innerX + 1, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1, mat_1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_px);
        this.setFace(inner.face_px, [0, 0, 0, 0, 0, 0]);
        inner.face_px = undefined;
      }
    }
  }

  private updateFaceNy(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_ny === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_ny = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_ny, [
          this.getVert(innerX + 0, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1, mat_0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1, mat_1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0, mat_1),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_ny);
        this.setFace(inner.face_ny, [0, 0, 0, 0, 0, 0]);
        inner.face_ny = undefined;
      }
    }
  }

  private updateFacePy(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_py === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_py = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_py, [
          this.getVert(innerX + 0, innerY + 1, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0, mat_0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_py);
        this.setFace(inner.face_py, [0, 0, 0, 0, 0, 0]);
        inner.face_py = undefined;
      }
    }
  }

  private updateFaceNz(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_nz === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_nz = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_nz, [
          this.getVert(innerX + 0, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0, mat_1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0, mat_1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_nz);
        this.setFace(inner.face_nz, [0, 0, 0, 0, 0, 0]);
        inner.face_nz = undefined;
      }
    }
  }

  private updateFacePz(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_pz === undefined) {
      if (inner.material && outer.material === 0) {
        inner.face_pz = this.allocFace();
        const mat_0 = showTriangles ? randomMaterial() : inner.material;
        const mat_1 = showTriangles ? randomMaterial() : inner.material;
        this.setFace(inner.face_pz, [
          this.getVert(innerX + 0, innerY + 0, innerZ + 1, mat_0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1, mat_0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1, mat_0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1, mat_1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1, mat_1),
        ]);
      }
    } else {
      if (inner.material === 0 || outer.material) {
        this.freeFaces.push(inner.face_pz);
        this.setFace(inner.face_pz, [0, 0, 0, 0, 0, 0]);
        inner.face_pz = undefined;
      }
    }
  }
}

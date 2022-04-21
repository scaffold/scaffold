import REGL from 'regl';
import { getOrCreate } from '~/sbl/util/map.ts';
import { assert } from '~/sbl/util/functional.ts';

interface Cell {
  isSolid: boolean;
  vert?: number;
  face_nx?: number;
  face_px?: number;
  face_ny?: number;
  face_py?: number;
  face_nz?: number;
  face_pz?: number;
}

const makeKey = (x: number, y: number, z: number) => `${x} ${y} ${z}`;
const createCell = (): Cell => ({ isSolid: false });

export default class VoxelMesher {
  private cells: Map<string, Cell> = new Map();

  // private vertPoss: [number, number, number][] = [];
  // private vertNorms: [number, number, number][] = [];
  // private faceIdxs: [number, number, number][] = [];

  public vertPosBuf: REGL.Buffer;
  public faceIdxBuf: REGL.Elements;

  private vertCount: number;
  private faceCount: number;

  private freeVerts: number[] = [];
  private freeFaces: number[] = [];

  private updateQueue: {}[] = [];

  constructor(regl: REGL.Regl) {
    this.vertPosBuf = regl.buffer({
      // data: undefined,
      length: 1024 * (3 * 4),
      type: 'float32',
      usage: 'dynamic',
    });
    this.vertCount = 1024;
    for (let i = 0; i < this.vertCount; i++) {
      this.freeVerts.push(i);
    }

    this.faceIdxBuf = regl.elements({
      // data: undefined,
      length: 1024 * (6 * 2),
      // count: undefined,
      primitive: 'triangles',
      // type: 'uint32',
      type: 'uint16',
      usage: 'dynamic',
    });
    this.faceCount = 1024;
    for (let i = 0; i < this.faceCount; i++) {
      this.freeFaces.push(i);
    }

    // this.vertNormBuf({ length: 10 });
    // this.vertNormBuf.subdata([4, 5, 6], 2);
    // this.vertNormBuf.destroy();
  }

  public destruct() {
    this.vertPosBuf.destroy();
    this.faceIdxBuf.destroy();
  }

  public set(x: number, y: number, z: number, isSolid: boolean) {
    const c_000 = getOrCreate(this.cells, makeKey(x, y, z), createCell);
    const c_900 = getOrCreate(this.cells, makeKey(x - 1, y, z), createCell);
    const c_100 = getOrCreate(this.cells, makeKey(x + 1, y, z), createCell);
    const c_090 = getOrCreate(this.cells, makeKey(x, y - 1, z), createCell);
    const c_010 = getOrCreate(this.cells, makeKey(x, y + 1, z), createCell);
    const c_009 = getOrCreate(this.cells, makeKey(x, y, z - 1), createCell);
    const c_001 = getOrCreate(this.cells, makeKey(x, y, z + 1), createCell);

    c_000.isSolid = isSolid;

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

  private getVert(x: number, y: number, z: number) {
    const cell = getOrCreate(this.cells, makeKey(x, y, z), createCell);
    if (!cell.vert) {
      cell.vert = this.allocVert();
      this.vertPosBuf.subdata([x, y, z], cell.vert * (3 * 4));
    }
    return cell.vert;
  }

  private updateFaceNx(
    inner: Cell,
    outer: Cell,
    innerX: number,
    innerY: number,
    innerZ: number,
  ) {
    if (inner.face_nx === undefined) {
      if (inner.isSolid && !outer.isSolid) {
        inner.face_nx = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 0, innerY + 0, innerZ + 0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1),
        ], inner.face_nx * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_nx);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_nx * (6 * 2));
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
      if (inner.isSolid && !outer.isSolid) {
        inner.face_px = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 1, innerY + 0, innerZ + 0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0),
        ], inner.face_px * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_px);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_px * (6 * 2));
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
      if (inner.isSolid && !outer.isSolid) {
        inner.face_ny = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 0, innerY + 0, innerZ + 0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0),
          this.getVert(innerX + 0, innerY + 0, innerZ + 1),
        ], inner.face_ny * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_ny);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_ny * (6 * 2));
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
      if (inner.isSolid && !outer.isSolid) {
        inner.face_py = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 0, innerY + 1, innerZ + 0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0),
        ], inner.face_py * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_py);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_py * (6 * 2));
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
      if (inner.isSolid && !outer.isSolid) {
        inner.face_nz = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 0, innerY + 0, innerZ + 0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0),
          this.getVert(innerX + 1, innerY + 1, innerZ + 0),
          this.getVert(innerX + 1, innerY + 0, innerZ + 0),
          this.getVert(innerX + 0, innerY + 1, innerZ + 0),
        ], inner.face_nz * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_nz);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_nz * (6 * 2));
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
      if (inner.isSolid && !outer.isSolid) {
        inner.face_pz = this.allocFace();
        this.faceIdxBuf.subdata([
          this.getVert(innerX + 0, innerY + 0, innerZ + 1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1),
          this.getVert(innerX + 1, innerY + 1, innerZ + 1),
          this.getVert(innerX + 0, innerY + 1, innerZ + 1),
          this.getVert(innerX + 1, innerY + 0, innerZ + 1),
        ], inner.face_pz * (6 * 2));
      }
    } else {
      if (!inner.isSolid || outer.isSolid) {
        this.freeFaces.push(inner.face_pz);
        this.faceIdxBuf.subdata([0, 0, 0, 0, 0, 0], inner.face_pz * (6 * 2));
        inner.face_pz = undefined;
      }
    }
  }
}

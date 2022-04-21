import { getOrCreate } from '~/sbl/util/map.ts';

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

  private position: [number, number, number][] = [];
  private normal: [number, number, number][] = [];
  private elements: [number, number, number][] = [];

  public set(x: number, y: number, z: number, isSolid: boolean) {
    getOrCreate(this.cells, makeKey(x, y, z), createCell);
  }

  public getMesh() {
    return {
      position: this.position,
      normal: this.normal,
      elements: this.elements,
    };
  }
}

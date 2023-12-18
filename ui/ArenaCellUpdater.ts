import { assert } from '~/sbl/util/functional.ts';
import { RedBlackTree } from 'std-latest/data_structures/mod.ts';

interface CacheEntry {
  uses: number;
  enters: { ox: number; oy: number }[];
  exits: { ox: number; oy: number }[];
}

const enableDebug = true;
const maxCacheSize = 64;
const usageDecay = 0.9;

const areSetsEqual = <T>(a: Set<T>, b: Set<T>) => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

export default class ArenaCellUpdater {
  private curX = 0;
  private curY = 0;
  private curRad = -1;

  private cache: Map<number, CacheEntry> = new Map();

  private setCells: Set<string> = new Set();

  private cleanupInterval = setInterval(() => this.cleanup(), 10000);

  constructor(
    private onCellEnter: (x: number, y: number) => void,
    private onCellExit: (x: number, y: number) => void,
  ) {}

  public destruct() {
    clearInterval(this.cleanupInterval);
  }

  public setArena(x: number, y: number, rad: number) {
    if (
      !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(rad)
    ) {
      throw new Error(`Arena bounds must be integers!`);
    }

    if (rad < 0) {
      throw new Error(`Arena radius must not be negative`);
    }

    while (x !== this.curX || y !== this.curY || rad !== this.curRad) {
      this.move(
        Math.sign(x - this.curX),
        Math.sign(y - this.curY),
        Math.sign(rad - this.curRad),
      );
    }
  }

  private move(dx: number, dy: number, dr: number) {
    if (
      (dx !== -1 && dx !== 0 && dx !== 1) ||
      (dy !== -1 && dy !== 0 && dy !== 1) ||
      (dr !== -1 && dr !== 0 && dr !== 1)
    ) {
      throw new Error(`Movements must be in unit steps`);
    }

    const key = (dx + 1) + (dy + 1) * 3 + (dr + 1) * 9 + this.curRad * 27;

    let entry = this.cache.get(key);
    if (!entry) {
      entry = ArenaCellUpdater.makeCacheEntry(this.curRad, dx, dy, dr);
      this.cache.set(key, entry);
    }
    entry.uses++;

    if (enableDebug) {
      entry.exits.forEach(({ ox, oy }) => {
        const key = `${this.curX + ox} ${this.curY + oy}`;
        if (!this.setCells.has(key)) {
          throw new Error(`Tried to exit a cell that wasn't entered`);
        }
        this.setCells.delete(key);
      });
      entry.enters.forEach(({ ox, oy }) => {
        const key = `${this.curX + ox} ${this.curY + oy}`;
        if (this.setCells.has(key)) {
          throw new Error(`Tried to enter a cell that wasn't exited`);
        }
        this.setCells.add(key);
      });
    }

    entry.exits.forEach(({ ox, oy }) =>
      this.onCellExit(this.curX + ox, this.curY + oy)
    );
    entry.enters.forEach(({ ox, oy }) =>
      this.onCellEnter(this.curX + ox, this.curY + oy)
    );

    this.curX += dx;
    this.curY += dy;
    this.curRad += dr;

    if (enableDebug) {
      const filled: Set<string> = new Set();
      const stack: { x: number; y: number }[] = [];
      ArenaCellUpdater.drawCircle(this.curRad, (x, y) => stack.push({ x, y }));
      while (stack.length) {
        const { x, y } = stack.pop()!;
        const key = `${this.curX + x} ${this.curY + y}`;
        if (filled.has(key)) {
          continue;
        }
        filled.add(key);

        // Flood fill towards center
        const nx = x - Math.sign(x);
        const ny = y - Math.sign(y);
        stack.push({ x, y: ny });
        stack.push({ x: nx, y });
      }

      if (!areSetsEqual(filled, this.setCells)) {
        throw new Error(`Cells are not what's expected`);
      }
    }
  }

  private static makeCacheEntry(
    curRad: number,
    dx: number,
    dy: number,
    dr: number,
  ) {
    if (
      (dx !== -1 && dx !== 0 && dx !== 1) ||
      (dy !== -1 && dy !== 0 && dy !== 1) ||
      (dr !== -1 && dr !== 0 && dr !== 1)
    ) {
      throw new Error(`Movements must be in unit steps`);
    }

    const enters: { ox: number; oy: number }[] = [];
    const exits: { ox: number; oy: number }[] = [];

    const queue: RedBlackTree<{ x: number; y: number; isEnter: boolean }> =
      new RedBlackTree((a, b) =>
        // Order first by euclidean distance
        a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y ||
        // Then by the X coordinate, so the same cell will be processed sequentially
        a.x - b.x ||
        // Then by the Y coordinate
        a.y - b.y ||
        // Then by: exit < enter
        (a.isEnter ? 1 : 0) - (b.isEnter ? 1 : 0)
      );

    ArenaCellUpdater.drawCircle(
      curRad,
      (x, y) => queue.insert({ x, y, isEnter: false }),
    );
    ArenaCellUpdater.drawCircle(
      curRad + dr,
      (x, y) => queue.insert({ x: x + dx, y: y + dy, isEnter: true }),
    );

    while (true) {
      const furthest = queue.max();
      if (!furthest) {
        break;
      }
      queue.remove(furthest);

      const { x, y, isEnter } = furthest;
      let gotEnter = isEnter;
      let gotExit = !isEnter;

      // Remove all queue entries with same coordinate
      while (true) {
        const next = queue.max();
        if (!next) {
          break;
        }
        if (next.x !== x || next.y !== y) {
          break;
        }
        if (next.isEnter) {
          gotEnter = true;
        } else {
          gotExit = true;
        }
        queue.remove(next);
      }

      if (gotEnter !== gotExit) {
        if (gotEnter) {
          enters.push({ ox: x, oy: y });

          // Flood fill towards (dx, dy)
          if (x !== dx) {
            queue.insert({ x: x - Math.sign(x - dx), y, isEnter: true });
          }
          if (y !== dy) {
            queue.insert({ x, y: y - Math.sign(y - dy), isEnter: true });
          }
        } else {
          exits.push({ ox: x, oy: y });

          // Flood fill towards (0, 0)
          if (x) {
            queue.insert({ x: x - Math.sign(x), y, isEnter: false });
          }
          if (y) {
            queue.insert({ x, y: y - Math.sign(y), isEnter: false });
          }
        }
      }
    }

    return { uses: 0, enters, exits };
  }

  private static drawCircle(rad: number, cb: (x: number, y: number) => void) {
    let x = 0;
    let y = rad;
    let err = 0;
    while (x <= y) {
      cb(x, y);
      cb(y, x);
      cb(y, -x);
      cb(x, -y);
      cb(-x, -y);
      cb(-y, -x);
      cb(-y, x);
      cb(-x, y);

      x++;
      if (err < 0) {
        err += 2 * x - 1;
      } else {
        err += 2 * (x - y);
        y--;
      }

      if (enableDebug) {
        assert(x * x + y * y - err === rad * rad);
      }
    }
  }

  private cleanup() {
    [...this.cache.entries()]
      .sort(([, a], [, b]) => b.uses - a.uses)
      .slice(maxCacheSize)
      .forEach(([idx, _entry]) => this.cache.delete(idx));
    this.cache.forEach((cache) => cache.uses *= usageDecay);
  }
}

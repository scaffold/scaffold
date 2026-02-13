// import * as jsondiffpatch from 'npm:jsondiffpatch';
// import * as consoleFormatter from 'npm:jsondiffpatch/formatters/console';
import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';
import { Logger } from './Logger.ts';

export type Snapshot = { [key: string]: SnapshotValue } | SnapshotValue[];
export type SnapshotValue = Snapshot | string | number | boolean | undefined;

export class SnapshotService {
  private stateLogger?: Logger;
  private diffLogger?: Logger;

  private snapshotters: { name: string; object: { snapshot(): Snapshot } }[] = [];

  private lastSnapshot?: Snapshot;
  // private differ?: jsondiffpatch.DiffPatcher;

  constructor(ctx: Context) {
    this.stateLogger = Logger.create(ctx, LogSystem.SnapshotState);
    this.diffLogger = Logger.create(ctx, LogSystem.SnapshotDiff);

    if (this.diffLogger !== undefined) {
      // this.differ = jsondiffpatch.create({});
    }
  }

  register(name: string, object: { snapshot(): Snapshot }) {
    this.snapshotters.push({ name, object });
  }

  snapshot() {
    if (this.stateLogger !== undefined || this.diffLogger !== undefined) {
      const snapshot = Object.fromEntries(
        this.snapshotters.map(({ name, object }) => [name, object.snapshot()]),
      );
      this.stateLogger?.info('Snapshot state', snapshot);

      // if (this.differ !== undefined) {
      //   const delta = this.differ.diff(this.lastSnapshot, snapshot);
      //   const output = consoleFormatter.format(delta);
      //   this.diffLogger?.info('Snapshot diff', output);
      //   this.lastSnapshot = snapshot;
      // }
    }
  }
}

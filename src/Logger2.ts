/*
Ingested a block 929bdafc from cab00edb
Setting the epoch base time to 1694052600495, which was 0 ms ago
Created 2 fact from 0: 6cb38683a888ce31191189ae9c4442bdea934cc1992d847c468f463d3ed75fc2
ProtocolProvider websocket is listening with spec "ws://127.0.0.1:8314"Worker starting...
INFO Running generation on worker_1 in job 5e2bcfb7 for contract fa1ff0c1 and params a8af5d5b
INFO Running generation on Worker_1 in job 5e2bcfb7 for contract fa1ff0c1, params a8af5d5b, and body 26bdafde
TRACE Worker 1 job 5e2bcfb7 called environ_sizes_get with args [1048572,1048568]
INFO Worker 1 job 5e2bcfb7 finished

Hover highlight
Click to filter (GTE or EQUAL)
Decrease/increase log level
Unbusy timestamps
Pretty source hash/public key
*/

import { Context } from './Context.ts';

export enum LogLevel {
  TRACE,
  DEBUG,
  INFO,
  WARNING,
  ERROR,
  FATAL,
}

export const enum FilterAction {
  EQ,
  GTE,
}

export interface LogAttribute {
  preposition: string;
  prefix?: string;
  filterAction: FilterAction;
  onFilter?: (value?: unknown) => void;
}

export type LogHandler = (
  level: LogLevel,
  participle: string,
  attrs: Record<string, unknown>,
) => void;

export class Logger {
  private attrs = new Map<string, LogAttribute>();

  constructor(private ctx: Context) {}

  public registerAttribute(key: string, config: LogAttribute) {
    this.attrs.set(key, config);
  }

  public registerHandler(handler: LogHandler) {
  }

  public parseLog(
    nodes: string[],
    cb: (key: string, value: unknown) => void,
    level: LogLevel,
    participle: string,
    attrs: Record<string, unknown>,
  ) {
    console.log(LogLevel[level], participle, attrs);

    nodes.push(LogLevel[level]);
    nodes.push(' ');
    nodes.push(participle);

    let prevPrep: string | undefined;
    let doublePrep = false;
    let lastPrepIdx = 0;
    for (const [key, attr] of Object.entries(attrs)) {
      const config = this.attrs.get(key);
      if (config === undefined) {
        throw new Error(`No log attribute registered for key ${key}!`);
      }

      if (doublePrep) {
        nodes[lastPrepIdx] = ', ';
        lastPrepIdx = nodes.length;
        nodes.push(', and ');
      }
      if (config.preposition === prevPrep) {
        if (!doublePrep) {
          lastPrepIdx = nodes.length;
          nodes.push(' and ');
          doublePrep = true;
        }
      } else {
        prevPrep = config.preposition;
        // doublePrep = false;
        nodes.push(` ${config.preposition} `);
      }
      if (config.prefix !== undefined) {
        nodes.push(`${config.prefix} `);
      }
      cb(key, attr);

      // INFO Running generation on Worker_1 in job 5e2bcfb7 for contract fa1ff0c1, params a8af5d5b, and body 26bdafde
    }

    console.log(nodes.join(''));
  }
}

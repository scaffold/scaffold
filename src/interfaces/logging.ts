export enum LogSystem {
  Main = 'main',
  Fact = 'fact',
  Connection = 'connection',
  Signaler = 'signaler',
  Worker = 'worker',
  Verification = 'verification',
  Generation = 'generation',
  Constraint = 'constraint',
  SnapshotState = 'snapshot_state',
  SnapshotDiff = 'snapshot_diff',
}

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  CRITICAL = 50,
}

export interface LogEvent {
  system: LogSystem;
  timestamp: number;
  level: LogLevel;
  message: string;
  data: unknown;
}

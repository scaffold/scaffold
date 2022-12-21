import Context from './Context.ts';

export default class OnlineGuarantee {
  private onlineDurationPromiseMs = 0;

  constructor(private ctx: Context) {}

  public setOnlineDurationPromiseMs(val: number) {
    this.onlineDurationPromiseMs = val;
  }
}

import Context from '~/sbl/Context.ts';

export default class ShutdownService {
  private flag = false;

  constructor(private ctx: Context) {}

  public async shutdown() {
    this.flag = true;

    while (this.hasPendingLitigations()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  public isShuttingDown() {
    return this.flag;
  }

  private hasPendingLitigations() {
    return false;
  }
}

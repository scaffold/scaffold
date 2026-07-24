import { Context } from '../Context.ts';
import { Draft, DRAFT_TYPE } from './types.ts';

export class DraftStore {
  private drafts = new Set<Draft>();

  constructor(private ctx: Context) {}

  upsert({ claims }: Pick<Draft, 'claims'>, replace?: Draft) {
    if (replace !== undefined && this.drafts.delete(replace)) {
      // Handle any callbacks here
    }

    const draft: Draft = {
      type: DRAFT_TYPE,
      claims,
    };

    this.drafts.add(draft);
  }
}

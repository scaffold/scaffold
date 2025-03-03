import { NotUndefined } from './functional.ts';
import { mapPut } from './map.ts';

const recursionSentinel = Symbol('MetricManager.RecursionSentinel');

type MetricState<Metrics> = {
  [Key in keyof Metrics]?: Metrics[Key] | typeof recursionSentinel;
};

export class MetricManager<Entity, Metrics extends { [key: string]: NotUndefined }> {
  private data = new Map<Entity, MetricState<Metrics>>();

  constructor(private generator: { [Key in keyof Metrics]: (entity: Entity) => Metrics[Key] }) {}

  reset() {
    this.data.clear();
  }

  get<Key extends keyof Metrics>(entity: Entity, key: Key): Metrics[Key] {
    const entry = mapPut(this.data, entity, (): MetricState<Metrics> => ({}));
    const val = entry[key];
    if (val === undefined) {
      entry[key] = recursionSentinel;
      const val = this.generator[key](entity);
      entry[key] = val;
      return val;
    } else if (val === recursionSentinel) {
      throw new Error(`Cyclic recursion detected!`);
    } else {
      return val as Metrics[Key];
    }
  }
}

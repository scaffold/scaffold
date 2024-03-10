import { IngestionProvider } from '../IngestionProvider.ts';
import { Fact, FactType } from '../FactMeta.ts';
import { Context } from '../Context.ts';
import { BlockIngestor } from './BlockIngestor.ts';
import { SignalPayloadIngestor } from './SignalPayloadIngestor.ts';

export const defaultIngestionProviders: {
  new (context: Context): IngestionProvider<any>;
}[] = [
  BlockIngestor,
  SignalPayloadIngestor,
];

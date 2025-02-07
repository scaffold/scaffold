import { IngestionProvider, ReceptionProvider } from '../IngestionProvider.ts';
import { Context } from '../Context.ts';
import { BlockIngestor } from './BlockIngestor.ts';
import { ConnectionSignalIngestor } from './ConnectionSignalIngestor.ts';
import { PeerInfoIngestor } from './PeerInfoIngestor.ts';
import { IndexIngestor } from './IndexIngestor.ts';
import { Fact, FactType } from '../FactMeta.ts';

export const defaultIngestionProviders: {
  new (context: Context): IngestionProvider<FactType> | ReceptionProvider<FactType>;
}[] = [
  PeerInfoIngestor,
  ConnectionSignalIngestor,
  BlockIngestor,
  IndexIngestor,
];

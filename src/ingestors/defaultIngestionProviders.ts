import { IngestionProvider } from '../IngestionProvider.ts';
import { Context } from '../Context.ts';
import { BlockIngestor } from './BlockIngestor.ts';
import { ConnectionSignalIngestor } from './ConnectionSignalIngestor.ts';
import { PeerInfoIngestor } from './PeerInfoIngestor.ts';
import { IdentificationIngestor } from './IdentificationIngestor.ts';

export const defaultIngestionProviders: {
  new (context: Context): IngestionProvider<any>;
}[] = [
  IdentificationIngestor,
  PeerInfoIngestor,
  ConnectionSignalIngestor,
  BlockIngestor,
];

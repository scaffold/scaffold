import { makeDefaultConfig } from './Config.ts';
import { Gossip } from './peer/network/Gossip.ts';
import { GeneratorRole } from './roles/GeneratorRole.ts';
import { ScaffoldConfig } from './Scaffold.ts';

export function makeBrowserConfig(): ScaffoldConfig {
  return {
    ...makeDefaultConfig(),
    roles: [Gossip, GeneratorRole],
  };
}

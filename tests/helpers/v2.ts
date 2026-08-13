import { SeededEntropyProvider } from '../../plugins/SeededEntropyProvider.ts';
import { Config } from '../../src/Config.ts';
import { Context } from '../../src/Context.ts';
import { DefaultContractProvider } from '../../src/contract/DefaultContractProvider.ts';
import { WasmConfig } from '../../src/contract/wasm/WasmConfig.ts';
import { fetchBlob } from '../../src/peer/blobFetch.ts';
import { generateGenesis } from '../../src/genesis.ts';
import { LoggingProvider } from '../../src/interfaces/LoggingProvider.ts';
import { TransportPlugin } from '../../src/interfaces/transport.ts';
import { Transport } from '../../src/peer/network/Transport.ts';
import { Hash } from '../../src/util/Hash.ts';
import { bin2hex } from '../../src/util/hex.ts';
import { secp } from '../../src/util/secp.ts';

export const testPrivateKey = (name: string): Uint8Array => Hash.digest(name).toBytes();

/** 33-byte compressed public key -- the form `generateGenesis` requires. */
export const testPublicKey = (name: string): Uint8Array =>
  secp.getPublicKey(testPrivateKey(name), true);

export interface TestConfigOptions {
  /** Genesis funding, keyed by the name whose *public* key receives it. */
  funding?: Record<string, bigint>;
  seed?: string;
  selfPrivateKey?: Uint8Array;
  transportPlugins?: TransportPlugin[];
  bootstrapUrls?: (string | URL)[];
}

export function makeTestConfig(options: TestConfigOptions = {}): Config {
  const funding = options.funding ?? { alice: 1_000_000n };

  const outputToPublicKeys: Record<string, bigint> = {};
  for (const [name, amount] of Object.entries(funding)) {
    outputToPublicKeys[bin2hex(testPublicKey(name))] = amount;
  }

  return {
    genesis: generateGenesis(options.seed ?? 'test', outputToPublicKeys),
    debugName: 'test',
    selfPrivateKey: options.selfPrivateKey ?? testPrivateKey('alice'),
    timeProvider: {
      nowMs: () => 0,
      setImmediate: (cb) => setTimeout(cb, 0),
      setTimeout: (cb, delayMs) => setTimeout(cb, delayMs),
      clearTimeout: (idx) => clearTimeout(idx),
      setInterval: (cb, delayMs) => setInterval(cb, delayMs),
      clearInterval: (idx) => clearInterval(idx),
    },
    entropyProvider: new SeededEntropyProvider(123n),
    contractPlugin: DefaultContractProvider,
  };
}

export function makeTestContext(
  options: TestConfigOptions & { loggingProvider?: LoggingProvider } = {},
): Context {
  const config = makeTestConfig(options);
  config.loggingProvider = options.loggingProvider;
  const ctx = new Context(config);
  ctx.configure(WasmConfig, { fetchBlob });

  const plugins = options.transportPlugins ?? [];
  const urls = options.bootstrapUrls ?? [];
  if (plugins.length > 0 || urls.length > 0) {
    const transport = ctx.get(Transport);
    for (const plugin of plugins) transport.startTransport(plugin);
    for (const url of urls) transport.connect(url instanceof URL ? url : new URL(url));
  }

  return ctx;
}

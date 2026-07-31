import { EntropyProvider } from '../Config.ts';
import { Context } from '../Context.ts';
import { arrEquals } from '../util/buffer.ts';
import { error } from '../util/functional.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { BlockIngestor, Ingestor, UnknownIngestor } from './Ingestor.ts';
import { Atom, AtomBase, AtomType, BlockRef } from './types.ts';

const atomMagic = new Uint8Array([83, 67, 70]); // SCF == 0x534346
export const headerSize = atomMagic.byteLength + 1;

const SIGNATURE_LENGTH = 64 + 1; // We shouldn't export this, since it's an implementation detail

export abstract class AtomSerializerModule {
  protected abstract factories: { [key in AtomType]: Ingestor<Atom> };

  protected abstract getPrivateKey(): Uint8Array;
  protected abstract getEntropyProvider(): EntropyProvider;

  serialize<Type extends AtomType>(
    type: Type,
    payload: (Atom & { type: Type })['payload'],
  ): Uint8Array {
    const ingestor = this.factories[type];

    let buf: Uint8Array;
    ingestor.serialize(payload, (size) => {
      buf = new Uint8Array(headerSize + size + (ingestor.isSigned ? SIGNATURE_LENGTH : 0));
      return buf.subarray(headerSize, headerSize + size);
    });
    const raw = buf!;

    raw.set(atomMagic);
    raw[atomMagic.byteLength] = type;

    if (ingestor.isSigned) {
      const size = raw.byteLength - SIGNATURE_LENGTH;
      const sig = secp.sign(
        Hash.digest(raw.subarray(0, size)).toBytes(),
        this.getPrivateKey(),
        { lowS: true, extraEntropy: this.getEntropyProvider().cryptoRandomBytes(32) },
      );
      const sigBytes = sig.toCompactRawBytes();
      if (sigBytes.byteLength !== SIGNATURE_LENGTH - 1) {
        throw new Error(`Internal error: Unexpected signature length!`);
      }
      raw.set(sigBytes, size);

      if (
        sig.recovery !== 0 && sig.recovery !== 1 &&
        sig.recovery !== 2 && sig.recovery !== 3
      ) {
        throw new Error(`Invalid signature recovery bit ${sig.recovery}!`);
      }
      raw[raw.byteLength - 1] = sig.recovery;
    }

    return raw;
  }

  deserialize(
    { hash, source, receivedAt, raw }: Pick<AtomBase, 'hash' | 'source' | 'receivedAt' | 'raw'>,
    ref?: BlockRef,
  ): Atom {
    if (raw.byteLength < headerSize) {
      throw new Error(`Message length (${raw.byteLength}) is too short!`);
    }
    if (!arrEquals(raw.subarray(0, atomMagic.byteLength), atomMagic)) {
      throw new Error(`Atom doesn't start with the magic bytes!`);
    }

    const type: AtomType = raw[atomMagic.byteLength];

    const ingestor = this.factories[type] ?? error(`Invalid message type ${type}!`);

    let message: Uint8Array;
    let signature: Uint8Array | undefined;
    let signer: Uint8Array | undefined;
    if (ingestor.isSigned) {
      if (raw.byteLength < SIGNATURE_LENGTH + headerSize) {
        throw new Error(`Message length (${raw.byteLength}) is too short!`);
      }

      message = raw.subarray(headerSize, -SIGNATURE_LENGTH);

      const hash = Hash.digest(raw.subarray(0, -SIGNATURE_LENGTH));
      signature = raw.subarray(-SIGNATURE_LENGTH);
      const sig = secp.Signature.fromCompact(signature.subarray(0, SIGNATURE_LENGTH - 1));

      // ECDSA is malleable: (r, n - s) verifies for the same key, so without this anyone
      // relaying an atom could mint a second raw with a different hash and the same signer.
      if (sig.hasHighS()) {
        throw new Error(`Signature is not canonical (high S)!`);
      }

      signer = sig.addRecoveryBit(signature[SIGNATURE_LENGTH - 1])
        .recoverPublicKey(hash.toBytes()).toRawBytes();
    } else {
      message = raw.subarray(headerSize);
    }

    const base: AtomBase = {
      hash,
      type,
      source,
      receivedAt,
      raw,
      message,
      signature,
      signer,
      fromConnections: [],
      toConnections: new Set(),
    };

    return ingestor.deserialize(base, ref);
  }

  ingest(atom: Atom): void {
    this.factories[atom.type].ingest(atom);
  }
}

export class AtomSerializerService extends AtomSerializerModule {
  protected factories: { [key in AtomType]: Ingestor<Atom> };

  constructor(private ctx: Context) {
    super();

    this.factories = {
      [AtomType.Block]: new BlockIngestor(ctx),
      [AtomType.Signal]: new UnknownIngestor(),
      [AtomType.Request]: new UnknownIngestor(),
    };
  }

  protected getPrivateKey(): Uint8Array {
    return this.ctx.config.selfPrivateKey;
  }

  protected getEntropyProvider(): EntropyProvider {
    return this.ctx.config.entropyProvider;
  }
}

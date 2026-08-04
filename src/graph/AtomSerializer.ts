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

export abstract class AtomSerializerBase {
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
      const sig = secp.sign(raw.subarray(0, size), this.getPrivateKey(), {
        lowS: true,
        format: 'recovered',
        extraEntropy: this.getEntropyProvider().cryptoRandomBytes(32),
      });
      if (sig.byteLength !== SIGNATURE_LENGTH) {
        throw new Error(`Internal error: Unexpected signature length!`);
      }
      raw.set(sig, size);
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

      signature = raw.subarray(-SIGNATURE_LENGTH);
      // Throws on an out-of-range recovery byte or a non-canonical r/s.
      const sig = secp.Signature.fromBytes(signature, 'recovered');

      // ECDSA is malleable: (r, n - s) verifies for the same key, so without this anyone
      // relaying an atom could mint a second raw with a different hash and the same signer.
      if (sig.hasHighS()) {
        throw new Error(`Signature is not canonical (high S)!`);
      }

      signer = secp.recoverPublicKey(signature, raw.subarray(0, -SIGNATURE_LENGTH));
    } else {
      message = raw.subarray(headerSize);
    }

    const base: AtomBase = { hash, type, source, receivedAt, raw, message, signature, signer };

    return ingestor.deserialize(base, ref);
  }

  ingest(atom: Atom): void {
    this.factories[atom.type].ingest(atom);
  }
}

export class AtomSerializer extends AtomSerializerBase {
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

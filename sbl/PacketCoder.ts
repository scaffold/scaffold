import { MessageType } from './ConnectionService.ts';
import Context from './Context.ts';
import { Coder } from './messages.ts';
import Hash from './util/Hash.ts';
import secp from './util/secp.ts';

export const SIGNATURE_LENGTH = 64;

// TODO: Consider [type_idx][block][signature?]
// This allows signature-less blocks more easily

export default class PacketCoder {
  constructor(private ctx: Context) {}

  public encode<MsgType>(
    msg: MsgType,
    coder: Coder<MsgType>,
    typeIdx: MessageType,
  ) {
    let buf: Uint8Array;
    coder.encode(msg, (size) => {
      buf = new Uint8Array(SIGNATURE_LENGTH + 1 + size);
      return buf.subarray(SIGNATURE_LENGTH + 1);
    });
    const data = buf!;
    data[SIGNATURE_LENGTH] = typeIdx;

    const sig = secp.sign(
      Hash.digest(data.subarray(SIGNATURE_LENGTH)).toBytes(),
      this.ctx.config.selfPrivateKey,
      { lowS: true, extraEntropy: secp.etc.randomBytes(32) },
    ).toCompactRawBytes();
    if (sig.byteLength !== SIGNATURE_LENGTH) {
      throw new Error(`Internal error: Unexpected signature length!`);
    }
    data.set(sig, 0);

    return data;
  }

  public getTypeIdx(data: Uint8Array) {
    return data[SIGNATURE_LENGTH] as MessageType;
  }
}

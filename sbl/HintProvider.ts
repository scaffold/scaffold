export interface HintProvider {
  suggestNext(params: Uint8Array, hints: Uint8Array[]): Uint8Array[];
}

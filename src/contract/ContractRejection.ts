// A deterministic contract refusal: generation gives up, verification says
// invalid. Anything else thrown from contract execution is a crash.
export class ContractRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractRejection';
  }
}

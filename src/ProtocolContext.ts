import { BaseContext } from './BaseContext.ts';

/** Lean DI container for the protocol layer. Services register via ctx.get(ServiceClass). */
export class ProtocolContext extends BaseContext<ProtocolContext> {
  protected override getThis(): ProtocolContext {
    return this;
  }
}

import Hash from './util/Hash.ts';

interface GraphGateway {
  reserve(fromAccount: Hash, amount: bigint, expiration: bigint): any;
  transfer(reservation: any, toAccount: Hash): void;
}

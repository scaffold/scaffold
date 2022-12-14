import Context from './Context.ts';
import { Block } from './messages.ts';
import Distribution from './util/Distribution.ts';
import Hash from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';

const addObservation = (
  map: Map<string, Distribution>,
  key: string,
  observation: number,
) =>
  getOrCreate(map, key, () => {
    const dist = new Distribution();
    dist.addObservation(1);
    dist.addObservation(observation);
    return dist;
  }, (dist) => {
    dist.addObservation(observation);
    return dist;
  });
const predict = (map: Map<string, Distribution>, key: string) =>
  getOrCreate(map, key, () => {
    const dist = new Distribution();
    dist.addObservation(1);
    return dist;
  }).getMean();

export default class ExpectedProfitPredictor {
  // TODO: Naive Bayes classifier?

  private doGenerationProfit: Map<string, Distribution> = new Map();
  private ensureMergeabilityProfit: Map<string, Distribution> = new Map();
  private checkValidProfit: Map<string, Distribution> = new Map();

  constructor(private ctx: Context) {}

  public learnDoGeneration(_block: Block, generatorHash: Hash, profit: number) {
    addObservation(this.doGenerationProfit, generatorHash.toHex(), profit);
  }

  public predictDoGeneration(_block: Block, generatorHash: Hash) {
    return predict(this.doGenerationProfit, generatorHash.toHex());
  }

  public learnEnsureMergeability(a: Block, b: Block, mergeable: number) {
    addObservation(
      this.ensureMergeabilityProfit,
      a.verifier.contract_hash.toHex() + b.verifier.contract_hash.toHex(),
      mergeable,
    );
  }

  public predictEnsureMergeability(a: Block, b: Block) {
    return predict(
      this.ensureMergeabilityProfit,
      a.verifier.contract_hash.toHex() + b.verifier.contract_hash.toHex(),
    );
  }

  public learnCheckValid(block: Block, profit: number) {
    addObservation(
      this.checkValidProfit,
      block.verifier.contract_hash.toHex(),
      profit,
    );
  }

  public predictCheckValid(block: Block) {
    return predict(this.checkValidProfit, block.verifier.contract_hash.toHex());
  }
}

import Context from '~/sbl/Context.ts';
import { Fact, FactType } from '~/sbl/FactMeta.ts';

export default class ResponseService {
  constructor(private ctx: Context) {}

  // A response is based around the reception of a Fact from a Node (whether or not it already existed), and the response availability. We need a getResponses to query answering facts when we receive the question packet, and a getQueries to get question packets when we receive/generate an answer (to send the answer to their fromNodes).

  public getResponses(fact: Fact) {
    switch (fact.type) {
      case FactType.Block:
        break;
    }
  }

  public getQueries(fact: Fact) {}
}

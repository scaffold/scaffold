[...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

A -> B: {
  type: 'SUB',
  question: 'bb921d94a384397227909381837ef313fd90cd2e99f3326c40c5c4482aeca982',
  params: '123456789',
}

{
  type: 'SIGNED_PUB',
  contract_hash: 'a0cf1fe7fef1b1cf2f6c15d08c309a71f41ca4e81a3de2ffa5fbba70eca5a768',
  params: '123456789',

  inputs: ['publication hash; if it\'s a question hash, the validity of the output depends on the chosen canonical publication'],
  output: '987654321',

  claims: ['publication hash, since publications store the output incentives'],
  incentives: [{
    question: '0eece0fddfc86bb52b32fcf766edeea335bbc1163a28b2aa4456afa7c8f7fcc9',
    params: 'dsiuhfa',
    amount: 123,
  }],
}

// if incentives can be answer hashes, then answers can easily be collateralized
// OOOOO it's just byte sequences. If the answer data is another publication, it can be collateralized just as easily!!!
// For slow compute, fast verification, embed the payee address in the input data like a bitcoin block, so it can't be changed without changing the output & signature.


{
  type: 'SIGNED_PUB',
  contract_hash: 'collateral collection contract',
  params: 'collateralized answer hash',

  inputs: [],
  output: [
    'VALID',
    'SIGNED COLLATERALIZATION PUBLICATION 1',
    'SIGNED COLLATERALIZATION PUBLICATION 2',
    'SIGNED COLLATERALIZATION PUBLICATION 3',
    ...
  ],

  claims: ['publication hash, since publications store the output incentives'],
  incentives: [{
    question: '0eece0fddfc86bb52b32fcf766edeea335bbc1163a28b2aa4456afa7c8f7fcc9',
    params: 'dsiuhfa',
    amount: 123,
  }],
}

/*
A signed collateralization publication is only valid IFF the canonical containing contract (the collector contract) has the same validity.
If the validity is different, the collateral is forfeit.
  If it's VALID and the collateral was posted against INVALID:
    It goes to the VALID posters in order of posting, cut in half. So each poster gets an additional 50% of their posting.
  If it's INVALID and the collateral was posted against VALID:
    Half goes to the INVALID posters in order of posting, cut in half. So each poster gets an additional 25% of their posting.
    Half goes to reconciliation.
      It's addressed to a contract that checks that its output is a publication that does not input the invalid answer.
      OR
      It's addressed to a contract that fulfils when the invalid answer is removed from the graph.

Canonicality differs:
  For collateral, it's the answer with the highest total amount collateralized.
  For game ticks, it's the one reached by traversing the game history.
  For an epoch, it should be the first.
    This is important, because we don't want to allow rewriting history.
Canonicality matters because it determines who receives the funds addressed to the parent question.

Free incentive?
  Free incentive is the incentive remaining inside the signed and collateralized answer.
  It can be added outside the signature, and edited by anyone.
    If it's just edited, it will be replaced.
    If it's locked into place by adding it as an input to a question, as long as it's not too greedy, it will likely stick.
The answer with the highest free incentive is canonical?
  Maybe even global (among all questions)?

Rewards:
  CITEs are preconditioned on an epoch. If the epoch is not canonical, the CITE is a no-op.
  CITEs start as a 1.0 at epochs and propagate toward inputs.
  Each input has a weight.
  The accumulation of CITEs is money.

  Payout is the product of CITEs and incentives
  This removes the need for consistency
*/

/*
Can either:
  Pay inputs NOW and set their weight to zero
  OR
  Pay inputs probablistically and set their weight to a positive fraction
    We already have this 
*/

bb1dadea04658e2a0d8cdea22bbc937d1a031ab94e03167b5133688ddde4df1f: {
  type: 'SIGNED_REQUEST',
  contract_hash: '6646badfa49665fcc61ffaec16901442a2e9b76b90e2df1ee8c4a94dafe2fa03',
  params: '123456789',
  amount: 0.6,
}

e05903ffb54ff4c4f2dbb1e450eab6020d8db1dbbcc45c0ae59ee9c5cfa2eda3: {
  type: 'SIGNED_CITABLE_PUB',
  contract_hash: 'a0cf1fe7fef1b1cf2f6c15d08c309a71f41ca4e81a3de2ffa5fbba70eca5a768',
  params: '123456789',

  claims: [{
    request_hash: 'bb1dadea04658e2a0d8cdea22bbc937d1a031ab94e03167b5133688ddde4df1f',
    amount: 0.6,
  }],

  // +

  inputs: [{
    weight: 0.4,
    publication_hash: 'publication hash; if it\'s a question hash, the validity of the output depends on the chosen canonical publication',
  }, {
    weight: 0.5,
    publication_hash: 'bb28474a4ea0dc6c1e4fbf5701f0e3646bc7ffbb56deb6e0beb234bcb64b5aac',
  }],
  output: '987654321',

  incentives: [{
    weight: 0.1,
    contract_hash: '8ea18f6cc84b47fbcebf79a5dcfc8dcfe64bfc116b7b0bbce6ec8f8cefe9e61e',
    params: '123456789',
  }],
}
{
  type: 'SIGNED_CITE',
  publication_hash: 'e05903ffb54ff4c4f2dbb1e450eab6020d8db1dbbcc45c0ae59ee9c5cfa2eda3',
  source_hash: 'a0ac3d11eaadc281b06e22555f3abcdbee19aaabbf0dad5ffc6eacaeb39eefc1', // Source epoch
  amount: 0.08,
  inputs: [
    '3bd2fc35cc0fa7089ddc4ce299a50ead3a2ceec1c81ab8ceca4b25bf9c28e8c6',
    '71e998d644b70e76d87bc5630d7f27c91c6faed8a59e26301242f807f5f861cf',
  ],
}

{
  type: 'SIGNED_PROMISE',
  data_hash: 'f2ebd3bcc1eacf6beacdfbd56bf2ec941eadb23ae4facbbe45eca94c75f48ca8',
  collateral: 123,
}
{
  type: 'SIGNED_RESOLUTION',
  data: null,

}

/*
If a hash is unknown, its derivations will be unverifiable, and they won't be used.

Send encrypted, signed message
Send signature of reception
Send decryption key

If a third party has the decryption key, and posts collateral that the data is there, he is incentivized to forward the key to peers so they'll back him up.

A request is a promise that you will receive N coins from CITEs?
Any less will be paid from an address, and any more will be paid to the address?

I don't think we need canonicality. Most of the time, just follow a path from the epoch.

SUB to UNHASH(x, epoch)
CITEs to UNHASHes are always paid to the account who first included it in the epoch chain.
To claim "firstness" over another answer to the same question, you must show the answer and publicize the data.

THE PLACES THAT USE THE DATA SHOULD REQUIRE ATTRIBUTION TO WHO PROVIDED IT.

The DHT stores the contents of hashes (hopefully very short decryption keys for the longer data).

Incentivization/requests
  {0.8, 0.3} -> {0.1}
Collateral?

*/


{
  type: 'SIGNED_COLLATERAL',
  collateralized_answer_hash: '3fcdc8d89b76c406ec5f7a8f4ab4d070affc4dbecc5dccfe5de9d91b8bba4cca',
  index: 0,
  vote: true,

  claims: ['publication hash sending collateral'],
  incentives: [{
    question: '0eece0fddfc86bb52b32fcf766edeea335bbc1163a28b2aa4456afa7c8f7fcc9',
    params: 'dsiuhfa',
    amount: 123,
  }],
}

/*
TODAY: Figure out collateral
2 fans; the VALID and INVALID fan.
The one that makes it into the network is canonical
*/
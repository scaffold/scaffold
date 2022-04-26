interface Question {
  contract: Answer;
  params: Uint8Array;
}

interface Answer {
  inputs: Answer[];
  outputs: { question: Question; amount: bigint }[];
}

const x = (answer: Answer) => {
  let available = 0n;
  answer.inputs.forEach((input) => {
  });
};

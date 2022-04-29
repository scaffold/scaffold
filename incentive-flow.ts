interface Question {
  contract: Answer;
  params: Uint8Array;
}

interface Answer {
  question:Question;
  inputs: Answer[];
  outputs: { question: Question; incentive: bigint }[];
}

const x = (answer: Answer) => {
  let available = 0n;
  answer.inputs.forEach((input) => {
    // Check for reclaims
    input.outputs.forEach((reclaimCandidate)=>{
      if (answer.inputs.some())
    })
  });
};

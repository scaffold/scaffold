(() => {
  debugger;
  const contractHash = ctx.get(ThrustGameContract).get().hash;
  const sub = ctx.get(QuestionService).getCanonical({
    contract_answer_hash: contractHash,
    params: thrustMessages.GameParams.encode({
      match,
      tick: 115n,
    }),
  });
  sub.onAnswer((answer) => console.log(answer));
  sub.incentivize(10000n);
})();

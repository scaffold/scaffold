open util/graph[Block] as graph

sig Block {
  frontier: lone Block,
  frontierInputs: set Block,
  height: one Int,
  inputs: set Block,
}

fact BlockConstraints {
  all b: Block | b !in b.^inputs
  one b: Block | no b.frontier
  all b: Block | (b.height = 0 and #b.frontierInputs = 0) or #b.frontierInputs = 2
  all b: Block | all fi: b.frontierInputs | b.height + 1 = fi.height
}

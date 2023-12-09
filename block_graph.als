sig Block {
  height: one Int,
  frontier: lone Block,
  treeInputs: set Block,
  inputs: set Block,
}

one sig Root extends Block {}

pred Graph {
  Root.*~(frontier + treeInputs + inputs) = Block
  no Root.frontier
  Root.height = 0
  all b: Block - Root | one b.frontier

  all b: Block | b.inputs & b.treeInputs = none
  all b: Block | b !in b.^(frontier + treeInputs + inputs)
  all b: Block | b.(inputs + treeInputs) in b.^(frontier + treeInputs)
  all b: Block | (b.height = 0 and #b.treeInputs = 0) or (b.height > 0 and #b.treeInputs = 2)
  all b: Block | all ti: b.treeInputs | b.height fun/sub 1 = ti.height

  some b: Block | b.height > 1
}

run Graph for 10

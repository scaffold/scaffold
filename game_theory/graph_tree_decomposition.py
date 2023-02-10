# https://sagecell.sagemath.org
# https://github.com/sagemath/sage/blob/develop/src/sage/graphs/graph_decompositions/tree_decomposition.pyx

from sage.graphs.graph_decompositions.tree_decomposition import TreelengthConnected
g = DiGraph([(0, 2), (1, 2), (1, 4), (1, 5), (1, 6), (2, 3), (2, 4), (3, 4), (4, 6), (4, 7), (5, 6), (6, 7)])
g.plot().show()
TreelengthConnected(g.to_undirected(), certificate=True).get_tree_decomposition().plot().show()
TreelengthConnected(g, certificate=True).get_tree_decomposition().plot().show()

# https://en.wikipedia.org/wiki/Dynamic_programming
# https://en.wikipedia.org/wiki/Tree_decomposition
# https://en.wikipedia.org/wiki/Bellman%E2%80%93Ford_algorithm
# https://arxiv.org/pdf/2009.13184.pdf
# https://www.mi.fu-berlin.de/en/inf/groups/abi/teaching/lectures/lectures_past/WS0910/V____Discrete_Mathematics_for_Bioinformatics__P1/material/scripts/treedecomposition1.pdf
# https://math.mit.edu/~apost/courses/18.204-2016/18.204_Gerrod_Voigt_final_paper.pdf
# https://courses.engr.illinois.edu/cs474/fa2021/fa2020Notes/TreeDecompositions.pdf
# https://arxiv.org/pdf/1912.09144.pdf
# http://www.cs.cmu.edu/~odonnell/toolkit13/lecture17.pdf
# https://thomas.math.gatech.edu/PAP/algofind.pdf
# https://en.wikipedia.org/wiki/PageRank
# https://en.wikipedia.org/wiki/Bayesian_network
# https://en.wikipedia.org/wiki/Belief_propagation
# https://en.wikipedia.org/wiki/Dynamic_connectivity
# https://en.wikipedia.org/wiki/Red%E2%80%93black_tree
# https://stackoverflow.com/questions/70569481/data-structure-to-efficiently-calculate-sum-of-reachable-weights-on-dynamic-dire
# https://cstheory.stackexchange.com/questions/8703/data-structure-for-shortest-paths
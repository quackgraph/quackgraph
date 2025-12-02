use crate::topology::{GraphIndex, Direction};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct PatternEdge {
    pub src_var: usize,
    pub tgt_var: usize,
    pub type_id: u8,
    pub direction: Direction,
}

/// A simple backtracking solver for subgraph isomorphism.
/// Finds all assignments of graph nodes to pattern variables such that all pattern edges exist.
///
/// Assumptions:
/// 1. Variable 0 is the "start" variable, seeded by `start_candidates`.
/// 2. The pattern is connected: for any variable `i > 0`, there is at least one constraint
///    connecting it to a variable `j < i`.
pub struct Matcher<'a> {
    graph: &'a GraphIndex,
    pattern: &'a [PatternEdge],
    num_vars: usize,
}

impl<'a> Matcher<'a> {
    pub fn new(graph: &'a GraphIndex, pattern: &'a [PatternEdge]) -> Self {
        let mut max_var = 0;
        for e in pattern {
            max_var = max_var.max(e.src_var).max(e.tgt_var);
        }
        Self {
            graph,
            pattern,
            num_vars: max_var + 1,
        }
    }

    pub fn find_matches(&self, start_candidates: &[u32]) -> Vec<Vec<u32>> {
        let mut results = Vec::new();
        let mut assignment = vec![None; self.num_vars];
        let mut used_nodes = HashSet::new();

        for &start_node in start_candidates {
            if self.graph.is_node_deleted(start_node) {
                continue;
            }

            assignment[0] = Some(start_node);
            used_nodes.insert(start_node);
            
            self.backtrack(1, &mut assignment, &mut used_nodes, &mut results);
            
            used_nodes.remove(&start_node);
            assignment[0] = None;
        }

        results
    }

    fn backtrack(
        &self,
        current_var: usize,
        assignment: &mut Vec<Option<u32>>,
        used_nodes: &mut HashSet<u32>,
        results: &mut Vec<Vec<u32>>,
    ) {
        if current_var == self.num_vars {
            results.push(assignment.iter().map(|opt| opt.unwrap()).collect());
            return;
        }

        let mut candidates: Option<Vec<u32>> = None;

        for edge in self.pattern {
            if edge.src_var < current_var && edge.tgt_var == current_var {
                let known_node = assignment[edge.src_var].unwrap();
                let neighbors = self.graph.get_neighbors(known_node, edge.type_id, Direction::Outgoing);
                candidates = self.intersect(candidates, neighbors);
                if candidates.as_ref().is_some_and(|c| c.is_empty()) { return; }
            }
            else if edge.src_var == current_var && edge.tgt_var < current_var {
                let known_node = assignment[edge.tgt_var].unwrap();
                let neighbors = self.graph.get_neighbors(known_node, edge.type_id, Direction::Incoming);
                candidates = self.intersect(candidates, neighbors);
                if candidates.as_ref().is_some_and(|c| c.is_empty()) { return; }
            }
        }
        
        if let Some(cands) = candidates {
            for cand in cands {
                if !used_nodes.contains(&cand) {
                    assignment[current_var] = Some(cand);
                    used_nodes.insert(cand);
                    
                    self.backtrack(current_var + 1, assignment, used_nodes, results);
                    
                    used_nodes.remove(&cand);
                    assignment[current_var] = None;
                }
            }
        }
    }

    fn intersect(&self, current: Option<Vec<u32>>, next: Vec<u32>) -> Option<Vec<u32>> {
        match current {
            None => Some(next),
            Some(curr) => {
                let set: HashSet<_> = next.into_iter().collect();
                Some(curr.into_iter().filter(|id| set.contains(id)).collect())
            }
        }
    }
}
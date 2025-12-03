use crate::interner::Interner;
use bitvec::prelude::*;
use std::collections::{HashMap, VecDeque};
use serde::{Serialize, Deserialize};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use arrow::record_batch::RecordBatch;
use arrow::array::{AsArray, Array, StringArray, LargeStringArray};
use arrow::datatypes::DataType;
use arrow::compute::cast;

pub const MAX_TIME: i64 = i64::MAX;

/// The core Graph Index.
/// Stores topology in RAM using integer IDs.
#[derive(Default, Debug, Serialize, Deserialize)]
pub struct GraphIndex {
    node_interner: Interner,
    
    // Mapping edge type strings (e.g. "KNOWS") to u8 for compact storage.
    // Limit: 256 edge types per graph in V1.
    edge_type_map: HashMap<String, u8>,
    edge_type_vec: Vec<String>,

    // Forward Graph: Source Node ID -> List of (Target Node ID, Edge Type ID, Valid From, Valid To)
    outgoing: Vec<Vec<(u32, u8, i64, i64)>>,
    
    // Reverse Graph: Target Node ID -> List of (Source Node ID, Edge Type ID, Valid From, Valid To)
    incoming: Vec<Vec<(u32, u8, i64, i64)>>,

    // Bitmask for soft-deleted nodes.
    // true = deleted (tombstone), false = active.
    tombstones: BitVec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Outgoing,
    Incoming,
}

impl GraphIndex {
    pub fn new() -> Self {
        Self {
            node_interner: Interner::new(),
            edge_type_map: HashMap::new(),
            edge_type_vec: Vec::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            tombstones: BitVec::new(),
        }
    }

    pub fn lookup_id(&self, id: &str) -> Option<u32> {
        self.node_interner.lookup_id(id)
    }

    pub fn lookup_str(&self, id: u32) -> Option<&str> {
        self.node_interner.lookup(id)
    }

    /// Compacts internal vectors to minimize memory usage.
    /// Also sorts and deduplicates adjacency lists (essential after bulk loading).
    /// Should be called after bulk hydration.
    pub fn compact(&mut self) {
        self.outgoing.iter_mut().for_each(|v| {
            v.sort_unstable();
            v.dedup();
            v.shrink_to_fit();
        });
        self.incoming.iter_mut().for_each(|v| {
            v.sort_unstable();
            v.dedup();
            v.shrink_to_fit();
        });
        self.outgoing.shrink_to_fit();
        self.incoming.shrink_to_fit();
        self.edge_type_vec.shrink_to_fit();
    }

    /// Resolves or creates an internal u32 ID for a node string.
    /// Resizes internal storage if necessary.
    pub fn get_or_create_node(&mut self, id: &str) -> u32 {
        let internal_id = self.node_interner.intern(id);
        let idx = internal_id as usize;

        // Ensure vectors are large enough to hold this node
        if idx >= self.outgoing.len() {
            let new_len = idx + 1;
            self.outgoing.resize_with(new_len, Vec::new);
            self.incoming.resize_with(new_len, Vec::new);
            // Resize tombstones, filling new slots with false (active)
            self.tombstones.resize(new_len, false);
        }
        internal_id
    }

    /// Marks a node as deleted (soft delete).
    /// Traversals will skip this node.
    pub fn remove_node(&mut self, id: &str) {
        if let Some(u_id) = self.node_interner.lookup_id(id) {
            let idx = u_id as usize;
            if idx < self.tombstones.len() {
                self.tombstones.set(idx, true);
            }
        }
    }

    pub fn is_node_deleted(&self, id: u32) -> bool {
        self.tombstones.get(id as usize).as_deref() == Some(&true)
    }

    /// Returns the total number of edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.outgoing.iter().map(|edges| edges.len()).sum()
    }

    /// Resolves or creates a u8 ID for an edge type string.
    /// Panics if more than 255 edge types are used (V1 constraint).
    pub fn get_or_create_type(&mut self, type_name: &str) -> u8 {
        if let Some(&id) = self.edge_type_map.get(type_name) {
            return id;
        }
        let id = self.edge_type_vec.len();
        if id > 255 {
            panic!("QuackGraph V1 Limit: Max 256 unique edge types supported.");
        }
        let id_u8 = id as u8;
        self.edge_type_vec.push(type_name.to_string());
        self.edge_type_map.insert(type_name.to_string(), id_u8);
        id_u8
    }

    pub fn get_type_id(&self, type_name: &str) -> Option<u8> {
        self.edge_type_map.get(type_name).copied()
    }

    /// Adds an edge to the graph. 
    /// Idempotent: Does not add duplicate edges if they already exist.
    /// If timestamps are not provided, defaults to (0, MAX_TIME).
    pub fn add_edge(&mut self, source: &str, target: &str, edge_type: &str, valid_from: Option<i64>, valid_to: Option<i64>) {
        let vf = valid_from.unwrap_or(0);
        let vt = valid_to.unwrap_or(MAX_TIME);
        
        let u_src = self.get_or_create_node(source);
        let u_tgt = self.get_or_create_node(target);
        let u_type = self.get_or_create_type(edge_type);

        // Add to forward index (Idempotent)
        let out_vec = &mut self.outgoing[u_src as usize];
        if !out_vec.contains(&(u_tgt, u_type, vf, vt)) {
            out_vec.push((u_tgt, u_type, vf, vt));
        }
        
        // Add to reverse index (Idempotent)
        let in_vec = &mut self.incoming[u_tgt as usize];
        if !in_vec.contains(&(u_src, u_type, vf, vt)) {
            in_vec.push((u_src, u_type, vf, vt));
        }

        // Ensure nodes are not tombstoned if they are being re-added/linked
        if self.tombstones.get(u_src as usize).as_deref() == Some(&true) {
            self.tombstones.set(u_src as usize, false);
        }
        if self.tombstones.get(u_tgt as usize).as_deref() == Some(&true) {
            self.tombstones.set(u_tgt as usize, false);
        }
    }

    /// Removes a specific edge from the graph.
    /// Uses swap_remove for O(1) removal, order is not preserved.
    pub fn remove_edge(&mut self, source: &str, target: &str, edge_type: &str) {
        // We only proceed if all entities exist in our interner/maps
        if let (Some(u_src), Some(u_tgt), Some(u_type)) = (
            self.node_interner.lookup_id(source),
            self.node_interner.lookup_id(target),
            self.edge_type_map.get(edge_type).copied(),
        ) {
            // Note: In V2 Temporal, removing an edge usually means "closing" the validity window.
            // However, this method removes it from RAM entirely (hard delete).
            // Remove from outgoing
            if let Some(edges) = self.outgoing.get_mut(u_src as usize) {
                if let Some(pos) = edges.iter().position(|x| x.0 == u_tgt && x.1 == u_type) {
                    edges.swap_remove(pos);
                }
            }
            // Remove from incoming
            if let Some(edges) = self.incoming.get_mut(u_tgt as usize) {
                if let Some(pos) = edges.iter().position(|x| x.0 == u_src && x.1 == u_type) {
                    edges.swap_remove(pos);
                }
            }
        }
    }

    /// Ingests an Apache Arrow RecordBatch directly.
    /// Expected Schema: Columns named "source", "target", "type" (case-insensitive or exact).
    pub fn add_arrow_batch(&mut self, batch: &RecordBatch) -> Result<(), String> {
        let schema = batch.schema();
        
        // Resolve column indices by name for robustness (Case-Insensitive)
        let find_col = |name: &str| -> Result<usize, String> {
            schema.fields().iter().position(|f| f.name().eq_ignore_ascii_case(name))
                .ok_or_else(|| format!("Column '{}' not found in Arrow Batch. Available: {:?}", name, schema.fields().iter().map(|f| f.name()).collect::<Vec<_>>()))
        };
        
        let num_rows = batch.num_rows();
        if num_rows == 0 {
            return Ok(());
        }

        // Helper to ensure we have a String/LargeString array, casting Dictionary if needed
        let prepare_col = |col: &std::sync::Arc<dyn Array>, name: &str| -> Result<std::sync::Arc<dyn Array>, String> {
            match col.data_type() {
                DataType::Utf8 | DataType::LargeUtf8 => Ok(col.clone()),
                DataType::Dictionary(_key_type, value_type) => {
                    match value_type.as_ref() {
                        // If we need to support dictionary encoded strings
                        DataType::Utf8 | DataType::LargeUtf8 => {
                            cast(col.as_ref(), value_type.as_ref())
                                .map_err(|e| format!("Cast error for {} column: {}", name, e))
                        },
                        other => {
                            Err(format!("{} column: Dictionary value type {:?} not supported (expected Utf8/LargeUtf8)", name, other))
                        }
                    }
                },
                dt => Err(format!("{} column: Unsupported type {:?}", name, dt)),
            }
        };

        let src_col = prepare_col(batch.column(find_col("source")?), "Source")?;
        let tgt_col = prepare_col(batch.column(find_col("target")?), "Target")?;
        let type_col = prepare_col(batch.column(find_col("type")?), "Type")?;

        // Optional Temporal Columns
        // If missing, we default to (0, MAX_TIME)
        let vf_idx = find_col("valid_from").ok();
        let vt_idx = find_col("valid_to").ok();

        let vf_col = if let Some(idx) = vf_idx {
            Some(cast(batch.column(idx).as_ref(), &DataType::Int64).map_err(|e| e.to_string())?)
        } else { None };
        let vt_col = if let Some(idx) = vt_idx {
            Some(cast(batch.column(idx).as_ref(), &DataType::Int64).map_err(|e| e.to_string())?)
        } else { None };

        // Wrapper to handle different string array types (Utf8 vs LargeUtf8)
        enum StringArrayWrapper<'a> {
            Small(&'a StringArray),
            Large(&'a LargeStringArray),
        }

        impl<'a> StringArrayWrapper<'a> {
            fn value(&self, i: usize) -> &'a str {
                match self {
                    Self::Small(arr) => arr.value(i),
                    Self::Large(arr) => arr.value(i),
                }
            }
        }

        macro_rules! get_wrapper {
            ($col:expr) => {
                match $col.data_type() {
                    DataType::Utf8 => StringArrayWrapper::Small($col.as_string::<i32>()),
                    DataType::LargeUtf8 => StringArrayWrapper::Large($col.as_string::<i64>()),
                    _ => unreachable!("Already validated/casted to Utf8/LargeUtf8"),
                }
            }
        }

        let src_wrapper = get_wrapper!(src_col);
        let tgt_wrapper = get_wrapper!(tgt_col);
        let type_wrapper = get_wrapper!(type_col);

        for i in 0..num_rows {
            let src = src_wrapper.value(i);
            let tgt = tgt_wrapper.value(i);
            let edge_type = type_wrapper.value(i);

            let u_src = self.get_or_create_node(src);
            let u_tgt = self.get_or_create_node(tgt);
            let u_type = self.get_or_create_type(edge_type);

            // Extract timestamps
            let valid_from = if let Some(ref col) = vf_col {
                col.as_any().downcast_ref::<arrow::array::Int64Array>().unwrap().value(i)
            } else { 0 };

            let valid_to = if let Some(ref col) = vt_col {
                let arr = col.as_any().downcast_ref::<arrow::array::Int64Array>().unwrap();
                if arr.is_null(i) {
                    MAX_TIME
                } else {
                    arr.value(i)
                }
            } else { MAX_TIME };

            // Fast Path: Blind push. We rely on compact() to deduplicate later.
            self.outgoing[u_src as usize].push((u_tgt, u_type, valid_from, valid_to));
            self.incoming[u_tgt as usize].push((u_src, u_type, valid_from, valid_to));

            // Ensure nodes are not tombstoned (revival logic)
            if self.tombstones.get(u_src as usize).as_deref() == Some(&true) {
                self.tombstones.set(u_src as usize, false);
            }
            if self.tombstones.get(u_tgt as usize).as_deref() == Some(&true) {
                self.tombstones.set(u_tgt as usize, false);
            }
        }
        Ok(())
    }

    /// Low-level neighbor access for Matcher.
    /// Returns all neighbors connected by `type_id` in `dir`.
    /// Returns all neighbors connected by `type_id` in `dir`, respecting `as_of`.
    /// Filters out tombstoned neighbors.
    pub fn get_neighbors(&self, node_id: u32, type_id: u8, dir: Direction, as_of: Option<i64>) -> Vec<u32> {
        let adjacency = match dir {
            Direction::Outgoing => &self.outgoing,
            Direction::Incoming => &self.incoming,
        };

        if let Some(edges) = adjacency.get(node_id as usize) {
            edges.iter()
                .filter_map(|&(target, t, vf, vt)| {
                    // Type match
                    if t != type_id { return None; }
                    // Tombstone check
                    if self.is_node_deleted(target) { return None; }
                    
                    // Temporal Check
                    match as_of {
                        Some(ts) => {
                            if vf <= ts && vt > ts { Some(target) } else { None }
                        },
                        None => {
                            // Current/Active only
                            if vt == MAX_TIME { Some(target) } else { None }
                        }
                    }
                })
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Generic traversal step (Bidirectional).
    /// Given a list of source node IDs (strings), find all neighbors connected by `edge_type`
    /// in the specified `direction`, visible at `as_of`.
    pub fn traverse(&self, sources: &[String], edge_type: Option<&str>, direction: Direction, as_of: Option<i64>) -> Vec<String> {
        let type_filter = edge_type.and_then(|t| self.edge_type_map.get(t).copied());
        
        let mut result_ids: Vec<u32> = Vec::with_capacity(sources.len() * 2);
        
        let adjacency = match direction {
            Direction::Outgoing => &self.outgoing,
            Direction::Incoming => &self.incoming,
        };

        for src_str in sources {
            // If source node doesn't exist in our index, skip it
            if let Some(src_id) = self.node_interner.lookup_id(src_str) {
                // Check if node is deleted
                if self.tombstones.get(src_id as usize).as_deref() == Some(&true) {
                    continue;
                }

                if let Some(edges) = adjacency.get(src_id as usize) {
                    for &(target, type_id, vf, vt) in edges {
                        // Apply edge type filter if present
                        if let Some(req_type) = type_filter {
                            if req_type != type_id {
                                continue;
                            }
                        }
                        // Temporal Check
                        match as_of {
                            Some(ts) => { if !(vf <= ts && vt > ts) { continue; } },
                            None => { if vt != MAX_TIME { continue; } }
                        }
                        // Check if target is deleted
                        if self.tombstones.get(target as usize).as_deref() == Some(&true) {
                            continue;
                        }
                        result_ids.push(target);
                    }
                }
            }
        }

        // Deduplicate results
        result_ids.sort_unstable();
        result_ids.dedup();

        // Convert back to strings
        result_ids
            .into_iter()
            .filter_map(|id| self.node_interner.lookup(id).map(|s| s.to_string()))
            .collect()
    }

    /// Recursive traversal (BFS) with depth bounds.
    /// Returns unique node IDs reachable within [min_depth, max_depth].
    pub fn traverse_recursive(
        &self,
        sources: &[String],
        edge_type: Option<&str>,
        direction: Direction,
        min_depth: usize,
        max_depth: usize,
        as_of: Option<i64>,
    ) -> Vec<String> {
        let type_filter = edge_type.and_then(|t| self.edge_type_map.get(t).copied());
        
        // Track visited nodes to prevent cycles (O(1) access)
        // We assume the interner length is the upper bound of IDs
        let mut visited = bitvec![u8, Lsb0; 0; self.node_interner.len()];
        let mut result_ids: Vec<u32> = Vec::new();
        
        // Queue stores (node_id, current_depth)
        let mut queue: VecDeque<(u32, usize)> = VecDeque::new();

        let adjacency = match direction {
            Direction::Outgoing => &self.outgoing,
            Direction::Incoming => &self.incoming,
        };

        // Initialize Queue
        for src_str in sources {
            if let Some(src_id) = self.node_interner.lookup_id(src_str) {
                // Skip soft-deleted nodes
                if self.tombstones.get(src_id as usize).as_deref() == Some(&true) {
                    continue;
                }
                
                // Mark source as visited so we don't loop back to it
                if (src_id as usize) < visited.len() {
                    visited.set(src_id as usize, true);
                }
                
                // If min_depth is 0, include sources in result
                if min_depth == 0 {
                    result_ids.push(src_id);
                }
                
                // Start search
                queue.push_back((src_id, 0));
            }
        }

        while let Some((curr_id, curr_depth)) = queue.pop_front() {
            if curr_depth >= max_depth {
                continue;
            }
            
            let next_depth = curr_depth + 1;

            if let Some(edges) = adjacency.get(curr_id as usize) {
                for &(target, type_id, vf, vt) in edges {
                    // Apply edge type filter
                    if let Some(req_type) = type_filter {
                        if req_type != type_id {
                            continue;
                        }
                    }
                    
                    // Temporal Check
                    match as_of {
                        Some(ts) => { if !(vf <= ts && vt > ts) { continue; } },
                        None => { if vt != MAX_TIME { continue; } }
                    }
                    
                    // Check soft delete
                    if self.tombstones.get(target as usize).as_deref() == Some(&true) {
                        continue;
                    }
                    
                    // Check visited and bounds
                    if (target as usize) < visited.len() && !visited[target as usize] {
                        visited.set(target as usize, true);
                        
                        if next_depth >= min_depth {
                            result_ids.push(target);
                        }
                        
                        // Continue BFS only if we haven't hit max depth
                        if next_depth < max_depth {
                            queue.push_back((target, next_depth));
                        }
                    }
                }
            }
        }

        // Sort for deterministic output
        result_ids.sort_unstable();

        result_ids
            .into_iter()
            .filter_map(|id| self.node_interner.lookup(id).map(|s| s.to_string()))
            .collect()
    }

    pub fn node_count(&self) -> usize {
        self.node_interner.len()
    }

    /// Serializes the entire graph topology to a binary file.
    pub fn save_to_file(&self, path: &str) -> Result<(), String> {
        let file = File::create(path).map_err(|e| e.to_string())?;
        let writer = BufWriter::new(file);
        bincode::serialize_into(writer, self).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Deserializes the graph topology from a binary file.
    pub fn load_from_file(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);
        bincode::deserialize_from(reader).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bulk_add_dedup() {
        let mut graph = GraphIndex::new();
        
        // Simulate batch loading with duplicates
        // A -> B (KNOWS)
        // A -> B (KNOWS)
        // A -> B (LIKES)
        
        let u_a = graph.get_or_create_node("A");
        let u_b = graph.get_or_create_node("B");
        let t_knows = graph.get_or_create_type("KNOWS");
        let t_likes = graph.get_or_create_type("LIKES");

        // Manually push duplicates simulating blind batch add
        graph.outgoing[u_a as usize].push((u_b, t_knows));
        graph.outgoing[u_a as usize].push((u_b, t_knows)); // Duplicate
        graph.outgoing[u_a as usize].push((u_b, t_likes)); // Different type

        // Pre-compact: 3 edges
        assert_eq!(graph.outgoing[u_a as usize].len(), 3);

        // Compact
        graph.compact();

        // Post-compact: 2 edges (KNOWS, LIKES)
        assert_eq!(graph.outgoing[u_a as usize].len(), 2);
        assert!(graph.outgoing[u_a as usize].contains(&(u_b, t_knows)));
        assert!(graph.outgoing[u_a as usize].contains(&(u_b, t_likes)));
    }
}
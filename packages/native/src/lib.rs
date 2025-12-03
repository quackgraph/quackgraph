#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use quack_core::{matcher::{Matcher, PatternEdge}, GraphIndex, Direction};
use arrow::ipc::reader::StreamReader;
use std::io::Cursor;

#[napi]
pub struct NativeGraph {
    inner: GraphIndex,
}

#[napi(object)]
pub struct JsPatternEdge {
    pub src_var: u32,
    pub tgt_var: u32,
    pub edge_type: String,
    pub direction: Option<String>,
}
#[napi]
impl NativeGraph {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: GraphIndex::new(),
        }
    }

    #[napi]
    pub fn add_node(&mut self, id: String) {
        self.inner.get_or_create_node(&id);
    }

    /// Hydrates the graph from an Arrow IPC stream (Buffer).
    /// Zero-copy (mostly) data transfer from DuckDB.
    /// Note: Does not verify duplicates. Caller must call compact() afterwards.
    #[napi]
    pub fn load_arrow_ipc(&mut self, buffer: Buffer) -> napi::Result<()> {
        let cursor = Cursor::new(buffer.as_ref());
        let reader = StreamReader::try_new(cursor, None).map_err(|e| napi::Error::from_reason(e.to_string()))?;

        for batch in reader {
            let batch = batch.map_err(|e| napi::Error::from_reason(e.to_string()))?;
            self.inner.add_arrow_batch(&batch).map_err(napi::Error::from_reason)?;
        }
        Ok(())
    }

    /// Compacts the graph's memory usage.
    /// Call this after hydration to reclaim unused capacity in the adjacency lists.
    /// Also deduplicates edges added via bulk ingestion.
    #[napi]
    pub fn compact(&mut self) {
        self.inner.compact();
    }

    #[napi]
    pub fn add_edge(&mut self, source: String, target: String, edge_type: String, valid_from: Option<f64>, valid_to: Option<f64>) {
        // JS timestamps are millis (f64). Convert to micros (i64) for DuckDB compatibility.
        let vf = valid_from.map(|t| (t * 1000.0) as i64);
        let vt = valid_to.map(|t| (t * 1000.0) as i64);
        self.inner.add_edge(&source, &target, &edge_type, vf, vt);
    }

    #[napi]
    pub fn remove_node(&mut self, id: String) {
        self.inner.remove_node(&id);
    }

    #[napi]
    pub fn remove_edge(&mut self, source: String, target: String, edge_type: String) {
        self.inner.remove_edge(&source, &target, &edge_type);
    }

    /// Performs a single-hop traversal (bfs-step).
    /// Returns unique neighbor IDs.
    #[napi]
    pub fn traverse(&self, sources: Vec<String>, edge_type: Option<String>, direction: Option<String>, as_of: Option<f64>) -> Vec<String> {
        let dir = match direction.as_deref() {
            Some("in") | Some("IN") => Direction::Incoming,
            _ => Direction::Outgoing,
        };
        // JavaScript now passes microseconds directly
        let ts = as_of.map(|t| t as i64);
        self.inner.traverse(&sources, edge_type.as_deref(), dir, ts)
    }

    /// Performs a recursive traversal (BFS) with depth bounds.
    /// Returns unique node IDs reachable within [min_depth, max_depth].
    #[napi(js_name = "traverseRecursive")]
    pub fn traverse_recursive(&self, sources: Vec<String>, edge_type: Option<String>, direction: Option<String>, min_depth: Option<u32>, max_depth: Option<u32>, as_of: Option<f64>) -> Vec<String> {
        let dir = match direction.as_deref() {
            Some("in") | Some("IN") => Direction::Incoming,
            _ => Direction::Outgoing,
        };
        
        let min = min_depth.unwrap_or(1) as usize;
        let max = max_depth.unwrap_or(1) as usize;
        let ts = as_of.map(|t| t as i64);
        
        self.inner.traverse_recursive(&sources, edge_type.as_deref(), dir, min, max, ts)
    }

    /// Finds subgraphs matching the given pattern.
    /// `start_ids` maps to variable 0 in the pattern.
    #[napi(js_name = "matchPattern")]
    pub fn match_pattern(&self, start_ids: Vec<String>, pattern: Vec<JsPatternEdge>, as_of: Option<f64>) -> Vec<Vec<String>> {
        let mut core_pattern = Vec::with_capacity(pattern.len());
        for p in pattern {
            if let Some(type_id) = self.inner.get_type_id(&p.edge_type) {
                core_pattern.push(PatternEdge {
                    src_var: p.src_var as usize,
                    tgt_var: p.tgt_var as usize,
                    type_id,
                    direction: match p.direction.as_deref() {
                        Some("in") | Some("IN") => Direction::Incoming,
                        _ => Direction::Outgoing,
                    },
                });
            } else {
                return Vec::new(); // Edge type doesn't exist, no matches possible.
            }
        }

        let start_candidates: Vec<u32> = start_ids.iter()
            .filter_map(|id| self.inner.lookup_id(id))
            .collect();

        if start_candidates.is_empty() {
            return Vec::new();
        }

        let ts = as_of.map(|t| t as i64);
        let matcher = Matcher::new(&self.inner, &core_pattern);
        let raw_results = matcher.find_matches(&start_candidates, ts);

        raw_results.into_iter().map(|row| {
            row.into_iter().filter_map(|uid| self.inner.lookup_str(uid).map(|s| s.to_string())).collect()
        }).collect()
    }

    /// Returns the number of nodes in the interned index.
    /// Useful for debugging hydration.
    #[napi(getter)]
    pub fn node_count(&self) -> u32 {
        // We cast to u32 because exposing usize to JS can be finicky depending on napi version,
        // though napi usually handles numbers well. Safe for V1.
        self.inner.node_count() as u32
    }

    #[napi(getter)]
    pub fn edge_count(&self) -> u32 {
        self.inner.edge_count() as u32
    }

    #[napi]
    pub fn save_snapshot(&self, path: String) -> napi::Result<()> {
        self.inner.save_to_file(&path).map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn load_snapshot(&mut self, path: String) -> napi::Result<()> {
        let loaded = GraphIndex::load_from_file(&path).map_err(napi::Error::from_reason)?;
        self.inner = loaded;
        Ok(())
    }
}

impl Default for NativeGraph {
    fn default() -> Self {
        Self::new()
    }
}
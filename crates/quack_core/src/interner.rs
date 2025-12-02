use std::collections::HashMap;
use serde::{Serialize, Deserialize};

/// A bidirectional map between String IDs and u32 internal indices.
/// Used to convert DuckDB UUIDs/Strings into efficient integers for the graph topology.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Interner {
    map: HashMap<String, u32>,
    vec: Vec<String>,
}

impl Interner {
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
            vec: Vec::new(),
        }
    }

    /// Interns a string: returns existing ID if present, or creates a new one.
    /// O(1) average case.
    pub fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.map.get(name) {
            return id;
        }
        let id = self.vec.len() as u32;
        let key = name.to_string();
        self.vec.push(key.clone());
        self.map.insert(key, id);
        id
    }

    /// Reverse lookup: u32 -> String.
    /// O(1) worst case.
    pub fn lookup(&self, id: u32) -> Option<&str> {
        self.vec.get(id as usize).map(|s| s.as_str())
    }

    /// Looks up the u32 ID for a given string name.
    /// O(1) average case.
    pub fn lookup_id(&self, name: &str) -> Option<u32> {
        self.map.get(name).copied()
    }

    /// Current number of interned items.
    pub fn len(&self) -> usize {
        self.vec.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vec.is_empty()
    }
}
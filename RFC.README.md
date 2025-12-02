# RCC.README.md 🏗️

> **Project:** QuackGraph (Core Engine)
> **Stack:** Bun (Runtime) + Rust (Compute) + DuckDB (Storage)
> **Architecture:** "Split-Brain" (In-Memory CSR + On-Disk Columnar)
> **License:** MIT

---

## 1. The Core Philosophy (Engineering Constraints)

To maintain performance and the "Embedded" promise, we strictly adhere to these constraints:

1.  **NO Garbage Collection in the Hot Path:** The traversal index must live in Rust `Vec<T>` (Native) or Wasm Linear Memory. We never store topology in JS Objects (`{ id: 'a', neighbors: [...] }`) to avoid V8 GC pauses.
2.  **NO Random Disk I/O:** Topology lives in RAM. Disk is only for sequential columnar scans (DuckDB).
3.  **NO Serialization Overhead:** We do not serialize JSON between DuckDB and Rust. We use **Apache Arrow** (IPC) pointers for Zero-Copy transfer.
4.  **DuckDB is the Source of Truth:** If the process crashes, RAM is lost. On restart, we Hydrate RAM from DuckDB. Rust is a *Transient Cache*.
5.  **Append-Only Storage:** We never `UPDATE` or `DELETE` rows in DuckDB. We insert new versions with `valid_from` timestamps.

---

## 2. Monorepo Structure

We use a **Bun Workspace** combined with a **Cargo Workspace**.

```text
/quack-graph
├── /packages
│   ├── /quack-graph        # Public TS API (The entry point)
│   ├── /native             # Napi-rs bindings (Node/Bun glue)
│   └── /wasm               # Wasm-bindgen bindings (Browser/Edge glue)
├── /crates
│   └── /quack_core         # Shared Rust Logic (The "Brain")
│       ├── /src/topology.rs  # CSR Index
│       └── /src/interner.rs  # String <-> u32
├── /benchmarks             # Performance testing suite
├── Cargo.toml              # Rust Workspace
├── package.json            # Bun Workspace
└── bun.lockb
```

---

## 3. The Rust Core Spec (`/crates/quack_core`)

This code must compile to both **CDYLIB** (Native) and **WASM32-UNKNOWN-UNKNOWN** (Edge).

### 3.1 The String Interner
Since DuckDB uses `TEXT` IDs (UUIDs), but fast traversal requires `u32` integers, we map them.

*   **Struct:** `BiMap` (Bidirectional Map).
*   **Forward:** `HashMap<String, u32>` (O(1) lookup).
*   **Reverse:** `Vec<String>` (Index lookup).
*   **Edge constraint:** On Cloudflare, `HashMap` overhead is significant.
    *   *Optimization V2:* Use a Double-Array Trie or enforce integer IDs for large graphs.

### 3.2 The Topology (Mutable CSR)
We use a hybrid Adjacency List that acts like a Compressed Sparse Row (CSR).

```rust
pub struct GraphIndex {
    // Forward Graph: Source u32 -> [(Target u32, Type u8)]
    // We use Vec<Vec<>> for O(1) appends during hydration.
    // Ideally, we compact this to flat Vec<u32> (CSR) after hydration.
    outgoing: Vec<Vec<(u32, u8)>>, 
    
    // Reverse Graph: Target u32 -> [(Source u32, Type u8)]
    // Required for .in() traversals
    incoming: Vec<Vec<(u32, u8)>>,
    
    // Bitmask for soft-deleted nodes (to avoid checking DuckDB for every hop)
    tombstones: BitVec,
}

### 3.3 The Graph Solver (Pattern Matching)
To match Neo4j's isomorphism capabilities (e.g., finding triangles or specific shapes), we implement a **Subgraph Isomorphism Solver** in Rust.
*   **Algorithm:** VF2 or Backtracking DFS with state pruning.
*   **Input:** A query graph (small topology of what we look for).
*   **Execution:**
    1.  Candidate Selection: Identify potential start nodes based on labels/properties (filtered by DuckDB).
    2.  Matching: Rust engine expands candidates, checking structural constraints.
    3.  Output: A set of matching path tuples `[(NodeA, NodeB, NodeC), ...]`.

### 3.4 Recursive Engine
To support `MATCH (n)-[:KNOWS*1..5]->(m)`, the CSR index must support depth-bounded traversals.
*   **Function:** `traverse_recursive(starts, type, min_depth, max_depth)`.
*   **Visited Set:** Essential to prevent cycles in infinite recursions.
*   **Memory:** Using a bitset for `visited` is efficient given we intern everything to `u32`.
```

---

## 4. The Storage Spec (DuckDB)

We treat DuckDB as a **Log-Structured Merge Tree (LSM)** style store.

### 4.1 Schema Definition

```sql
-- NODES
CREATE TABLE nodes (
    row_id UBIGINT PRIMARY KEY, -- Internal sequence for fast joins
    id TEXT NOT NULL,           -- Public ID
    labels TEXT[],              -- Multi-label support
    properties JSON,            -- Schemaless payload
    embedding FLOAT[1536],      -- Vector (HNSW)
    
    -- TEMPORAL COLUMNS
    valid_from TIMESTAMP DEFAULT current_timestamp,
    valid_to TIMESTAMP DEFAULT NULL -- NULL means 'Active'
);

-- EDGES
CREATE TABLE edges (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    type TEXT NOT NULL,
    properties JSON,
    valid_from TIMESTAMP DEFAULT current_timestamp,
    valid_to TIMESTAMP DEFAULT NULL
);
```

### 4.2 The Hydration Flow (Critical Path)
Startup time is the #1 KPI.

1.  **TS Layer:** Calls `duckdb.stream("SELECT source, target, type FROM edges WHERE valid_to IS NULL")`.
2.  **TS Layer:** Receives **Apache Arrow RecordBatch** (C++ memory pointer).
3.  **Bridge:** Passes the pointer to Rust via Napi/Wasm.
4.  **Rust Layer:**
    *   Reads `source` column (String View). Interns to `u32`.
    *   Reads `target` column (String View). Interns to `u32`.
    *   Updates `GraphIndex`.
5.  **Target Speed:** 1 Million Edges / second processing rate.

---

## 5. The Query Planner (`/packages/quack-graph`)

The TypeScript layer compiles the Fluent API into an **Execution Plan (AST V2)**.

**User Query:**
```typescript
g.match(['User']).as('a')
 .out('KNOWS').as('b')
 .out('KNOWS').as('c')
 .matchEdge('c', 'a', 'KNOWS') // Cycle
 .return('a', 'b', 'c')
```

**Compilation Pipeline (The "Solver" Model):**

1.  **Symbolic AST:** We track aliases (`a`, `b`) and their relationships.
2.  **Hybrid Optimization:**
    *   **Filter Pushdown:** DuckDB narrows the candidate sets for `a`, `b`, and `c` based on properties.
    *   **Pattern Extraction:** The topological constraints (`a->b`, `b->c`, `c->a`) are extracted into a "Pattern Query" for Rust.
3.  **Execution (Iterative Solver):**
    *   **Step 1 (Candidates):** DuckDB fetches IDs for start nodes.
    *   **Step 2 (Rust Solver):** The Rust engine runs VF2/Backtracking on the in-memory graph to find valid tuples `(id_a, id_b, id_c)`.
    *   **Step 3 (Projection):** The resulting tuples are joined back with DuckDB to fetch properties (`RETURN a.name, c.age`).

**Aggregations & Grouping:**
Aggregations (`count`, `avg`, `collect`) are pushed down to DuckDB's SQL engine on the final result set.

---

## 6. The Native Bridge (`/packages/native`)

We use `napi-rs` to expose Rust to Bun/Node.

```rust
// packages/native/src/lib.rs
use napi_derive::napi;
use quack_core::GraphIndex;

#[napi]
pub struct NativeGraph {
    inner: GraphIndex
}

#[napi]
impl NativeGraph {
    #[napi(constructor)]
    pub fn new() -> Self { ... }

    // Fast Bulk Load via Arrow
    #[napi]
    pub fn load_arrow_batch(&mut self, buffer_ptr: BigInt) {
        // Unsafe pointer magic to read Arrow batch from DuckDB
    }

    #[napi]
    pub fn traverse(&self, start_ids: Vec<String>, edge_type: String) -> Vec<String> {
        // Delegates to quack_core
    }
}
```

---

## 7. Development Workflow

### Prerequisites
1.  **Bun:** `curl -fsSL https://bun.sh/install | bash`
2.  **Rust:** `rustup update`
3.  **LLVM/Clang:** Required for building DuckDB extensions (if compiling from source).

### Setup

```bash
# 1. Install JS dependencies
bun install

# 2. Build the Rust Core & Bindings
# This runs cargo build inside /packages/native and /packages/wasm
bun run build:all

# 3. Run the Test Suite
# Uses Bun's native test runner (extremely fast)
bun test
```

### Running Benchmarks
We use a dedicated benchmark script to track regression in "Hydration" and "Traversal" speeds.

```bash
bun run bench
# Output:
# [Ingest] 100k nodes: 85ms
# [Hop] 3-depth traversal: 4ms
```

---

## 8. Cross-Platform Strategy

### Native (Backend)
*   **Tool:** `napi-rs`.
*   **Output:** `.node` binary file.
*   **Architecture:** We ship pre-built binaries for `linux-x64-gnu`, `linux-x64-musl`, `darwin-x64`, `darwin-arm64`, `win32-x64`.

### Edge (Wasm)
*   **Tool:** `wasm-pack`.
*   **Output:** `.wasm` file + JS glue.
*   **Constraint:** Wasm is single-threaded (mostly) and 32-bit address space (4GB limit).
*   **Storage:** On Edge, DuckDB uses `HTTPFS` to read Parquet from S3/R2, or `OPFS` in the browser.

---

## 9. Debugging & Profiling

### Rust Panics
Rust panics will crash the Bun process. To debug:
```bash
export RUST_BACKTRACE=1
bun test
```

### Memory Leaks
If `GraphIndex` grows indefinitely:
1.  Check `interner.rs`. Are we removing strings when nodes are deleted? (Current design: No, we tombstone. Strings leak until restart).
2.  Check Napi `External` references. Are we properly dropping Rust structs when JS objects are GC'd?

---

## 10. Future Proofing (Roadmap Specs)

### v0.5: Topology Snapshots
*   **Problem:** Hydration takes too long for 10M+ edges.
*   **Spec:** Implement `GraphIndex::serialize()` using `bincode` or `rkyv` (Zero-Copy deserialization framework).
*   **Flow:** Save `graph.bin` alongside `db.duckdb`. On boot, `mmap` `graph.bin` directly into memory.

### v0.8: Declarative Mutations (Merge)
*   **Problem:** "Check-then-Act" logic in JS is slow and race-condition prone.
*   **Spec:** Implement `MERGE` logic.
    *   Locking: Optimistic concurrency control or single-threaded writer queue.
    *   Logic: `INSERT ON CONFLICT DO UPDATE` generated in DuckDB.

### v1.0: Cypher Parser
*   **Problem:** DSL lock-in.
*   **Spec:** Use a PEG parser in Rust to parse Cypher strings into our internal AST.
*   **Goal:** `g.query("MATCH (n)-[:KNOWS]->(m) RETURN m")`.

### v1.0: Replication
*   **Problem:** Local-only limits usage.
*   **Spec:** Simple S3 sync.
*   **Command:** `g.sync.push('s3://bucket/latest')`.
*   **Logic:** Upload the `.duckdb` file and the `.bin` topology snapshot. Clients pull and hot-reload.

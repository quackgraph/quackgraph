===



Here is the **Test Suite Proposal** to harden QuackGraph for v1.0 production readiness.

This suite focuses on the "Split-Brain" architecture risks (consistency between Rust/RAM and DuckDB/Disk), hybrid OLAP/Graph capabilities, and heavy concurrency.

### 📂 `test/e2e/` (Domain Scenarios)
> *Real-world flows mixing Graph Hops with SQL Analytics.*

=== DONE

*   **`analytics-hybrid.test.ts`**  
    **The "Standard Deviation" Test.**
    1.  Generate 10k Products linked to Categories.
    2.  Traverse `Category -> HAS_PRODUCT -> Product`.
    3.  Compute `STDDEV(price)`, `AVG(price)`, and `Percentile(95)` on the resulting nodes using DuckDB native functions.
    4.  *Goal:* Prove QuackGraph isn't just a graph DB, but an analytical engine.

*   **`knowledge-graph-rag.test.ts`**  
    **Vector + Graph Hybrid.**
    1.  Insert nodes with 1536d dummy embeddings.
    2.  Perform HNSW search (`nearText`) to find top 5 entry points.
    3.  Traverse 2 hops out (`RELATED_TO`).
    4.  *Goal:* Verify the "Vector -> Graph" handover pipeline works without serialization overhead.

*   **`identity-resolution.test.ts`**  
    **Recursive Merging.**
    1.  Create disjoint subgraphs: `UserA -> Device1` and `UserB -> Device1`.
    2.  Query path linking `UserA` to `UserB` via shared device.
    3.  *Goal:* Verify undirected pathfinding and cycle detection in complex identity graphs.

*   **`infrastructure-routing.test.ts`**  
    **Weighted Paths (Simulation).**
    1.  Create a network topology (Servers -> Switches -> Routers).
    2.  Simulate "link failure" (Soft Delete edge).
    3.  Verify alternate path discovery immediately after deletion.
    4.  *Goal:* Test immediate consistency of the Rust topology after soft-deletes.

===

### 📂 `test/integration/` (System Mechanics)
> *Testing the Engine, ACID compliance, and "Split-Brain" synchronization.*

*   **`acid-rollback.test.ts`**  
    **Transaction Safety.**
    1.  Start transaction.
    2.  Write 100 nodes to DuckDB.
    3.  **Throw Error / Rollback.**
    4.  Verify Rust Index does *not* contain these nodes (or correctly reverts if optimistic).
    5.  *Goal:* Ensure the transient Rust index doesn't hallucinate data that failed to persist.

*   **`hydration-stress.test.ts`**  
    **The "Thundering Herd".**
    1.  Pre-seed DuckDB with 100k edges (bulk ingest).
    2.  Boot QuackGraph (measure cold-start time).
    3.  Verify 100% topology match between Disk and RAM.
    4.  *Goal:* Stress test the Apache Arrow IPC zero-copy stream.

*   **`schema-evolution.test.ts`**  
    **Hot-Swapping Columns.**
    1.  Write data as JSON blobs (`properties = { "score": 10 }`).
    2.  Run queries (slow path).
    3.  Call `promoteProperty('score', 'INTEGER')`.
    4.  Verify data migrated to new column and old JSON key is ignored/removed.
    5.  Run queries again (fast path).
    6.  *Goal:* Zero-downtime optimization verification.

*   **`concurrency-read-write.test.ts`**  
    **Snapshot Isolation.**
    1.  Writer: Adds a chain of 100 nodes slowly.
    2.  Reader: Traverses the chain repeatedly.
    3.  *Goal:* Ensure Reader never sees a "torn graph" (partial writes) or segfaults due to `Vec` resizing in Rust.

*   **`persistence-corruption.test.ts`**  
    **Disaster Recovery.**
    1.  Create valid snapshot `.bin`.
    2.  Corrupt random bytes in the file.
    3.  Boot QuackGraph.
    4.  *Goal:* Ensure it detects corruption, discards snapshot, and falls back to safe (but slower) DuckDB hydration.

---

### 📂 `test/unit/` (Low Level)
> *Isolated logic verification.*

*   **`interner.test.ts`**  
    1.  Intern 1M strings.
    2.  Verify memory usage (did we leak?).
    3.  Verify collision resistance (different strings, same hash if hashing used).
    
*   **`query-builder.test.ts`**  
    1.  Build complex "Sandwich" queries (Filter -> Trav -> Filter -> Trav).
    2.  Verify generated SQL string correctness (AST validation).
    3.  *Goal:* Prevent SQL injection and ensuring logical correctness of the query plan.

*   **`topology-serde.test.ts`**  
    1.  Build graph in memory.
    2.  Serialize to buffer -> Deserialize to new instance.
    3.  Compare `outgoing` adjacency lists byte-for-byte.

---

### 📂 `test/utils/` (Test Infrastructure)

*   **`generators.ts`**  
    *   `makeStarGraph(center: string, rays: number)`
    *   `makeChain(length: number)`
    *   `makeClique(size: number)`
    *   *Goal:* Deterministic topology generation for reproducible benchmarks.

*   **`chaos.ts`**  
    *   `corruptFile(path: string)`
    *   `simulatedLatency(ms: number)`

---

**Next Step:** Shall I proceed with implementing the **Infrastructure Utils** (`generators.ts`) and the **Hybrid Analytics E2E** (`analytics-hybrid.test.ts`) to prove the core value prop?


=== DONE

to meet expectations on README.md and RFC.README.md in production ready manner, as guardrails.

lets add many bun test cases files in test/e2e/[domain].test.ts test/integration/[domain].test.ts test/unit/[domain].test.ts test/utils/

rules;

1. real verify implementation
2. no mock and no spy
3. idempotent and clean even on sigterm
4. each cases should be isolated without noisy neighbor syndrom

so the test should enforce core implementation to be finish production ready. so test is single source of truth and proof.

also we need amazing queries like calculate the standard deviation of prices for 10M products

=== DONE

please develop the project up to meet expectations on README.md and RFC.README.md in production ready manner

=== DONE

I want running like bun typecheck and bun run lint from root will auto check everything even the rust code

=== DONE

based on README.md and RFC.README.md please develop the project up to production ready quality

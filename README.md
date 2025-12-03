# QuackGraph 🦆🕸️

[![npm version](https://img.shields.io/npm/v/quack-graph.svg?style=flat-square)](https://www.npmjs.com/package/quack-graph)
[![Build Status](https://img.shields.io/github/actions/workflow/status/your-repo/quack-graph/ci.yml?style=flat-square)](https://github.com/your-repo/quack-graph/actions)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun%20%2F%20Node-black.svg?style=flat-square)](https://bun.sh)
[![Engine: Rust](https://img.shields.io/badge/Accelerator-Rust%20(CSR)-orange.svg?style=flat-square)](https://www.rust-lang.org/)
[![Storage: DuckDB](https://img.shields.io/badge/Storage-DuckDB-brightgreen.svg?style=flat-square)](https://duckdb.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

> **The Embedded Graph Analytics Engine.**
>
> **Postgres is for records. QuackGraph is for relationships.**
>
> QuackGraph is a **serverless, infrastructure-less** graph index that runs alongside your app. It combines **DuckDB** (Columnar Storage) with a **Rust/Wasm CSR Index** (O(1) Traversal) via **Zero-Copy Apache Arrow**.
>
> No Docker containers. No JVM. Just `npm install` and raw speed.

---

## 📖 Table of Contents

1.  [**Why QuackGraph? (The Pitch)**](#-why-quackgraph-the-pitch)
2.  [**The Architecture: A "Split-Brain" Engine**](#-the-architecture-a-split-brain-engine)
3.  [**Installation**](#-installation)
4.  [**Quick Start (5 Minutes)**](#-quick-start-5-minutes)
5.  [**Core Concepts**](#-core-concepts)
    *   [Schemaless & Gradual Typing](#1-schemaless--gradual-typing)
    *   [GraphRAG (Vector Search)](#2-graphrag-vector-search)
    *   [Temporal Time-Travel](#3-temporal-time-travel)
    *   [Complex Patterns & Recursion](#4-complex-patterns--recursion)
    *   [Declarative Mutations](#5-declarative-mutations)
6.  [**Advanced Usage & Performance Tuning**](#-advanced-usage--performance-tuning)
    *   [Property Promotion](#property-promotion-json--native)
    *   [Topology Snapshots](#topology-snapshots-for-instant-boot)
    *   [Server-Side Aggregations](#server-side-aggregations)
    *   [Cypher Compatibility](#cypher-compatibility)
7.  [**Runtime Targets: Native vs. Edge**](#-runtime-targets-native-vs-edge)
8.  [**Comparison with Alternatives**](#-comparison-with-alternatives)
9.  [**Known Limits & Trade-offs**](#-known-limits--trade-offs)
10. [**Contributing**](#-contributing)
11. [**Roadmap**](#-roadmap)

---

## 💡 Why QuackGraph?

**The "SQLite for Graphs" Moment.**

Enterprises run Neo4j Clusters. Startups and Local-First apps don't have that luxury. You shouldn't need to deploy a heavy Java-based server just to query "friends of friends" or build a RAG pipeline.

QuackGraph is **CQRS in a box**:
1.  **Ingest:** Data lands in **DuckDB**. It's cheap, ACID-compliant, and handles millions of rows on a laptop.
2.  **Index:** We project the topology into a **Rust Compressed Sparse Row (CSR)** structure in RAM.
3.  **Query:** Graph traversals happen in nanoseconds (memory pointers), while heavy aggregations happen in DuckDB (vectorized SQL).

**Use Cases:**
*   **GraphRAG:** Combine Vector Search (HNSW) with Knowledge Graph traversal in a single process.
*   **Fraud Detection:** Detect cycles and rings in transaction logs without network latency.
*   **Local-First SaaS:** Ship complex analytics in Electron apps or Edge workers.

---

## 📐 Architecture: Zero-Copy Hybrid Engine

QuackGraph is not a database replacement; it is a **Read-Optimized View**. It leverages **Apache Arrow** to stream data from Disk to RAM at ~1GB/s.

```ascii
[ Your App (Bun / Node / Wasm) ]
     │
     ▼
[ QuackGraph DX Layer (TypeScript) ]
     │
     ├── Writes ───────────────┐
     │                         ▼
     │                 [ DuckDB Storage ] (Persistent Source of Truth)
     │                 (Parquet / JSON / WAL)
     │                         │
     ├── Reads (Filters) ◄─────┤
     │                         │
     │                 (Arrow IPC Stream for Hydration)
     │                         ▼
     └── Reads (Hops) ◄── [ Rust Index ] (Transient In-Memory Cache)
                          (CSR Topology)
```

1.  **DuckDB is King:** All writes (`addNode`, `addEdge`) go immediately and atomically to DuckDB.
2.  **Rust is a View:** The In-Memory Graph Index is a *read-optimized, transient view* of the data on disk.
3.  **Hydration:** On startup, we stream edges from DuckDB to Rust via Arrow IPC (~1M edges/sec).
4.  **Consistency:** If the process crashes, the RAM index is gone. No data loss occurs because the data is safely in `.duckdb`.

---

## 📦 Installation

Choose your runtime target.

### 🏎️ Native (Backend / CLI)
*Best for: Bun, Node.js, Electron, Tauri.*
Uses `napi-rs` for native C++ performance.

```bash
bun add quack-graph
```

### 🌍 Edge (Serverless / Browser)
*Best for: Cloudflare Workers, Vercel Edge, Local-First Web Apps.*
Uses WebAssembly.

```bash
bun add quack-graph @duckdb/duckdb-wasm apache-arrow
```

---

## ⚡ The API: Graph Topology meets SQL Analytics

Stop writing 50-line `WITH RECURSIVE` SQL queries.
QuackGraph gives you a Fluent TypeScript API for the topology, but lets you drop into raw SQL for the heavy lifting.

**The "Hybrid" Query Pattern:**
1.  **Graph Layer:** Use Rust to traverse hops instantly.
2.  **SQL Layer:** Use DuckDB to aggregate the results.

```typescript
import { QuackGraph } from 'quack-graph';
const g = new QuackGraph('./supply-chain.duckdb');

// Scenario: "Find all downstream products affected by a bad Lithium batch,
// and calculate the total inventory value at risk."

const results = await g
  // 1. Start: DuckDB Index Scan
  .match(['Material'])
  .where({ batch: 'BAD-BATCH-001' })

  // 2. Traversal: Rust In-Memory CSR (Nanoseconds)
  // Find everything this material flows into, up to 10 hops deep
  .out('PART_OF').depth(1, 10)

  // 3. Filter: Apply logic to the found nodes
  .node(['Product'])
  .where({ status: 'active' })

  // 4. Analytics: Push aggregation down to DuckDB (Zero Data Transfer)
  // We can write raw SQL inside .select()!
  .select(`
    id,
    properties->>'name' as product_name,
    (properties->>'price')::FLOAT * (properties->>'stock')::INT as value_at_risk
  `);

console.table(results);
/*
┌────────────┬──────────────┬───────────────┐
│ id         │ product_name │ value_at_risk │
├────────────┼──────────────┼───────────────┤
│ prod:ev_1  │ Tesla Model3 │ 1500000       │
│ prod:bat_x │ PowerWall    │ 45000         │
└────────────┴──────────────┴───────────────┘
*/
```

---

## 🧠 Core Concepts

### 1. Schemaless & Gradual Typing
Start with `any`. Harden with `Zod`. QuackGraph stores properties as a `JSON` column in DuckDB, allowing instant iteration. When you need safety, bind a Schema.

```typescript
import { z } from 'zod';
const UserSchema = z.object({ name: z.string(), role: z.enum(['Admin', 'User']) });

const g = new QuackGraph('db.duckdb').withSchemas({ User: UserSchema });
// TypeScript now provides strict autocomplete and runtime validation
```

### 2. GraphRAG (Vector Search)
Build **Local-First AI** apps. QuackGraph bundles `duckdb_vss` (HNSW Indexing). Your graph *is* your vector store.

```typescript
// Find documents similar to [Query], then find who wrote them
const authors = await g
  .nearText(['Document'], queryVector, { limit: 10 }) // HNSW Search
  .in('AUTHORED_BY')                                  // Graph Hop
  .node(['User'])
  .select(u => u.name);
```

### 3. Temporal Time-Travel
The database is **Append-Only**. We never overwrite data; we version it. This gives you Git-like history for your data.

```typescript
// Oops, someone deleted the edges? Query the graph as it existed 10 minutes ago.
const snapshot = g.asOf(new Date(Date.now() - 10 * 60 * 1000));
const count = await snapshot.match(['User']).count();
```

### 4. Complex Patterns & Recursion
Match Neo4j's expressiveness with fluent ergonomics.

**Variable-Length Paths (Recursive):**
```typescript
// Find friends of friends (1 to 5 hops away)
const network = await g.match(['User'])
  .where({ id: 'Alice' })
  .out('KNOWS').depth(1, 5)
  .select(u => u.name);
```

**Pattern Matching (Isomorphism):**
```typescript
// Find a "Triangle" (A knows B, B knows C, C knows A)
const triangles = await g.match(['User']).as('a')
  .out('KNOWS').as('b')
  .out('KNOWS').as('c')
  .matchEdge('c', 'a', 'KNOWS') // Close the loop
  .return(row => ({
    a: row.a.name,
    b: row.b.name,
    c: row.c.name
  }));
```

### 5. Declarative Mutations (Upserts)
Don't write race-condition-prone check-then-insert code. We provide atomic `MERGE` semantics equivalent to Neo4j.

```typescript
// Idempotent Ingestion
const userId = await g.mergeNode('User', { email: 'alice@corp.com' })
  .match({ email: 'alice@corp.com' })   // Look up by unique key
  .set({ last_seen: new Date() })       // Update if exists
  .run();
```

### 6. Batch Ingestion
For high-throughput scenarios, use batch operations to minimize transaction overhead.

```typescript
// Insert 10,000 nodes in one transaction
await g.addNodes([
  { id: 'u:1', labels: ['User'], properties: { name: 'Alice' } },
  { id: 'u:2', labels: ['User'], properties: { name: 'Bob' } }
]);

// Insert 50,000 edges
await g.addEdges([
  { source: 'u:1', target: 'u:2', type: 'KNOWS', properties: { since: 2022 } }
]);
```

---

## 🛠️ Advanced Usage & Performance Tuning

### Property Promotion (JSON -> Native)
Filtering inside large JSON blobs is slower than native columns. QuackGraph can materialize hot fields for you.

```typescript
// Background migration: pulls 'age' out of the JSON blob into a native INTEGER column for 50x faster reads.
await g.optimize.promoteProperty('User', 'age', 'INTEGER');
```

### Topology Snapshots (for Instant Boot)
The "Hydration" phase can be slow for huge graphs. You can snapshot the in-memory Rust index to disk.

```typescript
// Save the RAM index to disk
await g.optimize.saveTopologySnapshot('./topology.snapshot');

// On next boot, load the snapshot instead of re-reading from DuckDB
const g = new QuackGraph('./data.duckdb', { topologySnapshot: './topology.snapshot' });
```

### Server-Side Aggregations
Don't pull data back to JS just to count it. Push the math to DuckDB.

```typescript
// "MATCH (u:User) RETURN u.city, count(u) as pop"
const stats = await g.match(['User'])
  .groupBy(u => u.city)
  .count()
  .as('pop')
  .run();
```

### Cypher Compatibility
For easy migration and interoperability, you can run raw Cypher queries.

```typescript
// (Roadmap v1.0)
const results = await g.query(`
  MATCH (u:User {name: 'Alice'})-[:MENTORS]->(mentee:User)
  WHERE mentee.age < 30
  RETURN mentee.name
`);```

---

## 🎯 Runtime Targets: Native vs. Edge

| Feature | **Native (Bun/Node)** | **Edge (Wasm)** |
| :--- | :--- | :--- |
| **Engine** | Rust (Napi-rs) | Rust (Wasm) |
| **Performance** | 🚀 **Highest** | 🐇 Fast |
| **Cold Start** | ~50ms | ~400ms (Wasm boot) |
| **Max Memory** | System RAM | ~128MB (CF Workers) |
| **Best For** | Backends, CLI, Desktop | Serverless, Browser, Local-First |

---

## 🆚 Comparison with Alternatives

| Feature | QuackGraph 🦆 | Neo4j / TigerGraph | Raw SQL (Postgres/DuckDB) |
| :--- | :--- | :--- | :--- |
| **Deployment** | **`npm install`** | Docker / K8s Cluster | Docker / RDS |
| **Architecture** | **Embedded Library** | Standalone Server | Database Engine |
| **Latency** | **Nanoseconds (In-Proc)** | Milliseconds (Network) | Microseconds (IO) |
| **Vector RAG**| **Native (HNSW)** | Plugin Required | Extension (pgvector) |
| **Traversal** | **O(1) RAM Pointers** | O(1) RAM Pointers | O(log n) Index Joins |
| **Cost** | **$0 / Compute Only** | $$ License / Cloud | $ Instance Cost |

---

## ⚠️ Known Limits & Trade-offs

1.  **Memory Wall (Edge):**
    *   On Cloudflare Workers (128MB limit), the Graph Index can hold **~200k edges** before OOM.
    *   *Workaround:* Use integer IDs (`1001` vs `"user_uuid_v4"`) to save ~60% RAM.
2.  **Concurrency:**
    *   DuckDB is **Single-Writer**. This is not for high-concurrency OLTP (e.g., a Banking Ledger).
    *   It is designed for **Read-Heavy / Analytic** workloads (RAG, Recommendations, Dashboards).
3.  **Deep Pattern Matching:**
    *   While we support basic isomorphism (triangles, rings), extremely large subgraph queries (>10 node patterns) are computationally expensive in any engine. We optimize for "OLTP-style" pattern matching (small local patterns) rather than whole-graph analytics.

---

## 🤝 Contributing

We are building the standard library for Graph Data in TypeScript.
This project is a Bun Workspace monorepo.

1.  **Install:** `bun install`
2.  **Build Native:** `cd packages/native && bun build`
3.  **Run Tests:** `bun test`

All contributions are welcome. Please open an issue to discuss your ideas.

---

## 🗓️ Roadmap

*   ✅ **v0.1:** Core Engine (Native + Wasm).
*   🟡 **v0.5:** **Recursion & Patterns.** Rust-side VF2 solver and Recursive DFS.
*   ⚪️ **v1.0:** **Auto-Columnarization.** Background job that detects hot JSON fields and promotes them to native DuckDB columns.
*   ⚪️ **v1.1:** **Cypher Parser.** `g.query('MATCH (n)-[:KNOWS]->(m) RETURN m')` for easy migration.
*   ⚪️ **v1.2:** **Replication.** `g.sync('s3://bucket/graph')` for multi-device sync.

---

## 📄 License

**MIT**

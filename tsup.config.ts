import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['packages/quack-graph/src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  shims: false,
  sourcemap: true,
  clean: true,
  outDir: 'packages/quack-graph/dist',
  external: ['duckdb-async', 'apache-arrow', '@quackgraph/native'],
  target: 'es2020',
});
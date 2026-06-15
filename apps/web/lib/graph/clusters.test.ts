import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GRAPH_NEUTRAL } from './model';
import {
  assignClusterColors,
  buildClusterColors,
  clusterLegendEntries,
  CLUSTER_SINGLETON_THRESHOLD,
  computeConnectedComponents,
} from './clusters';

function n(id: string) {
  return { id };
}
function e(source: string, target: string) {
  return { source, target };
}

// ---------------------------------------------------------------------------
// computeConnectedComponents
// ---------------------------------------------------------------------------

test('empty graph returns zero clusters', () => {
  const r = computeConnectedComponents([], []);
  assert.equal(r.clusterCount, 0);
  assert.equal(r.nodeCluster.size, 0);
});

test('single node with no edges is its own cluster', () => {
  const r = computeConnectedComponents([n('a')], []);
  assert.equal(r.clusterCount, 1);
  assert.equal(r.nodeCluster.get('a'), 0);
  assert.equal(r.clusterSize.get(0), 1);
});

test('two nodes connected by one edge share a cluster', () => {
  const r = computeConnectedComponents([n('a'), n('b')], [e('a', 'b')]);
  assert.equal(r.clusterCount, 1);
  assert.equal(r.nodeCluster.get('a'), r.nodeCluster.get('b'));
  assert.equal(r.clusterSize.get(0), 2);
});

test('two isolated nodes form two separate clusters', () => {
  const r = computeConnectedComponents([n('a'), n('b')], []);
  assert.equal(r.clusterCount, 2);
  assert.notEqual(r.nodeCluster.get('a'), r.nodeCluster.get('b'));
});

test('three nodes in a chain all share one cluster', () => {
  const r = computeConnectedComponents([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')]);
  assert.equal(r.clusterCount, 1);
  const ids = new Set([r.nodeCluster.get('a'), r.nodeCluster.get('b'), r.nodeCluster.get('c')]);
  assert.equal(ids.size, 1);
});

test('two disconnected components are detected correctly', () => {
  // Component 1: a-b; Component 2: c-d
  const nodes = [n('a'), n('b'), n('c'), n('d')];
  const edges = [e('a', 'b'), e('c', 'd')];
  const r = computeConnectedComponents(nodes, edges);
  assert.equal(r.clusterCount, 2);
  assert.equal(r.nodeCluster.get('a'), r.nodeCluster.get('b'));
  assert.equal(r.nodeCluster.get('c'), r.nodeCluster.get('d'));
  assert.notEqual(r.nodeCluster.get('a'), r.nodeCluster.get('c'));
});

test('edges referencing unknown nodes are ignored gracefully', () => {
  const r = computeConnectedComponents([n('a'), n('b')], [e('a', 'z'), e('z', 'b')]);
  // 'z' is not in the node list → edge is silently dropped → a and b are separate
  assert.equal(r.clusterCount, 2);
});

test('directed edge treated as undirected (both directions connected)', () => {
  // Edge only goes a → b but both should still be in the same component.
  const r = computeConnectedComponents([n('a'), n('b')], [e('a', 'b')]);
  assert.equal(r.nodeCluster.get('a'), r.nodeCluster.get('b'));
});

test('clusterSize sums correctly across three clusters', () => {
  // Cluster of 3 nodes, cluster of 2 nodes, singleton
  const nodes = [n('a'), n('b'), n('c'), n('d'), n('e'), n('f')];
  const edges = [e('a', 'b'), e('b', 'c'), e('d', 'e')];
  const r = computeConnectedComponents(nodes, edges);
  assert.equal(r.clusterCount, 3);
  const sizes = [...r.clusterSize.values()].sort((a, b) => b - a);
  assert.deepEqual(sizes, [3, 2, 1]);
});

// ---------------------------------------------------------------------------
// assignClusterColors
// ---------------------------------------------------------------------------

test('singletons get the neutral colour', () => {
  assert.ok(
    CLUSTER_SINGLETON_THRESHOLD > 1,
    'threshold must be > 1 for this test to be meaningful',
  );
  const r = computeConnectedComponents([n('a')], []);
  const colorMap = assignClusterColors(r);
  assert.equal(colorMap.get(0), GRAPH_NEUTRAL);
});

test('large cluster gets a palette colour (not neutral)', () => {
  const r = computeConnectedComponents([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')]);
  const colorMap = assignClusterColors(r);
  const color = colorMap.get(0);
  assert.ok(color !== undefined);
  assert.notEqual(color, GRAPH_NEUTRAL);
  assert.match(color, /^#[0-9a-f]{6}$/i);
});

test('two large clusters get different palette colours', () => {
  const nodes = [n('a'), n('b'), n('c'), n('d')];
  const edges = [e('a', 'b'), e('c', 'd')];
  const r = computeConnectedComponents(nodes, edges);
  const colorMap = assignClusterColors(r);
  const colors = [...colorMap.values()];
  // Two clusters of size 2 (>= threshold) → two distinct palette colours
  assert.equal(colors.length, 2);
  assert.notEqual(colors[0], colors[1]);
});

// ---------------------------------------------------------------------------
// buildClusterColors
// ---------------------------------------------------------------------------

test('buildClusterColors nodeColor maps every input node', () => {
  const nodes = [n('a'), n('b'), n('c')];
  const edges = [e('a', 'b')];
  const { nodeColor } = buildClusterColors(nodes, edges);
  assert.ok(nodeColor.has('a'));
  assert.ok(nodeColor.has('b'));
  assert.ok(nodeColor.has('c'));
});

test('buildClusterColors connected nodes share colour', () => {
  const nodes = [n('a'), n('b'), n('c')];
  const edges = [e('a', 'b'), e('b', 'c')];
  const { nodeColor } = buildClusterColors(nodes, edges);
  assert.equal(nodeColor.get('a'), nodeColor.get('b'));
  assert.equal(nodeColor.get('b'), nodeColor.get('c'));
});

// ---------------------------------------------------------------------------
// clusterLegendEntries
// ---------------------------------------------------------------------------

test('clusterLegendEntries respects maxEntries limit', () => {
  // Build a graph with 10 clusters of size 3 each
  const nodes: { id: string }[] = [];
  const edges: { source: string; target: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = `${i}_a`,
      b = `${i}_b`,
      c = `${i}_c`;
    nodes.push(n(a), n(b), n(c));
    edges.push(e(a, b), e(b, c));
  }
  const r = computeConnectedComponents(nodes, edges);
  const colorMap = assignClusterColors(r);
  const legend = clusterLegendEntries(r, colorMap, 4);
  // At most maxEntries + possibly one "Isolated" row
  assert.ok(legend.length <= 5);
});

test('clusterLegendEntries adds isolated row when singletons exist', () => {
  const nodes = [n('a'), n('b'), n('c')];
  // a-b connected, c is isolated
  const r = computeConnectedComponents(nodes, [e('a', 'b')]);
  const colorMap = assignClusterColors(r);
  const legend = clusterLegendEntries(r, colorMap);
  const isolatedRow = legend.find((item) => item.label.startsWith('Isolated'));
  assert.ok(isolatedRow, 'should have an isolated row');
  assert.equal(isolatedRow!.color, GRAPH_NEUTRAL);
});

test('clusterLegendEntries has no isolated row when all nodes are in large clusters', () => {
  // All nodes connected in one cluster of size >= CLUSTER_SINGLETON_THRESHOLD
  const nodes = [n('a'), n('b'), n('c')];
  const r = computeConnectedComponents(nodes, [e('a', 'b'), e('b', 'c')]);
  const colorMap = assignClusterColors(r);
  const legend = clusterLegendEntries(r, colorMap);
  const isolatedRow = legend.find((item) => item.label.startsWith('Isolated'));
  assert.equal(isolatedRow, undefined);
});

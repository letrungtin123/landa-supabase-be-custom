export interface GeneratedDiagramLayoutNode {
  id: string;
  position: { x: number; y: number };
  data?: { label?: unknown };
}

export interface GeneratedDiagramLayoutEdge {
  source: string;
  target: string;
}

const NODE_WIDTH = 220;
const MIN_NODE_HEIGHT = 56;
const HORIZONTAL_GAP = 88;
const VERTICAL_GAP = 84;
const LEFT = 80;
const TOP = 70;

/** Remove wire/OCR newline tokens. Labels wrap naturally in the renderer. */
export function normalizeDiagramDisplayText(value: unknown, maximum = 500): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(?:\\r\\n|\\n|\\r|(?<![\p{L}\p{N}])\/n(?![\p{L}\p{N}]))/giu, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function nodeLabel(node: GeneratedDiagramLayoutNode): string {
  return normalizeDiagramDisplayText(node.data?.label, 140);
}

function estimatedNodeHeight(node: GeneratedDiagramLayoutNode): number {
  // Both dashboard and learner renderers use a fixed 220 px width, 32 px
  // horizontal padding and a 20 px line height. Keep the server estimate a
  // little conservative so wrapped Vietnamese labels cannot overlap.
  const visibleCharacters = Array.from(nodeLabel(node)).length;
  const lineCount = Math.max(1, Math.ceil(visibleCharacters / 24));
  return Math.max(MIN_NODE_HEIGHT, 28 + lineCount * 20);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY;
}

/**
 * Small deterministic layered layout for AI-generated teaching diagrams.
 * The generation path is synchronous; this avoids putting an async graph
 * engine on the proposal normalizer's hot path while still applying the
 * crossing-reduction and spacing steps needed by the two React Flow clients.
 */
export function layoutGeneratedDiagramNodes<T extends GeneratedDiagramLayoutNode>(
  nodes: T[],
  edges: readonly GeneratedDiagramLayoutEdge[],
): T[] {
  if (!nodes.length) return nodes;
  const ids = new Set(nodes.map(node => node.id));
  const originalOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  const layerById = new Map<string, number>();
  const visited = new Set<string>();
  const roots = nodes.filter(node => incoming.get(node.id)!.length === 0).map(node => node.id);
  const seeds = [...roots, ...nodes.map(node => node.id)];
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    const queue: Array<{ id: string; layer: number }> = [{ id: seed, layer: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      const existing = layerById.get(current.id);
      if (existing === undefined || current.layer > existing) layerById.set(current.id, current.layer);
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      for (const target of outgoing.get(current.id) ?? []) {
        if (!visited.has(target)) queue.push({ id: target, layer: current.layer + 1 });
      }
    }
  }

  // Relax acyclic forward edges to keep long paths in reading order. The
  // bounded pass count makes cycles deterministic and prevents runaway depth.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const sourceLayer = layerById.get(edge.source);
      const targetLayer = layerById.get(edge.target);
      if (sourceLayer === undefined || targetLayer === undefined || targetLayer <= sourceLayer) continue;
      const next = Math.min(nodes.length - 1, sourceLayer + 1);
      if (targetLayer < next) {
        layerById.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, T[]>();
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const layerNumbers = [...layers.keys()].sort((left, right) => left - right);
  const orderInLayer = new Map<string, number>();
  const rememberOrder = () => {
    for (const layer of layerNumbers) layers.get(layer)!.forEach((node, index) => orderInLayer.set(node.id, index));
  };
  rememberOrder();
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const forward = sweep % 2 === 0;
    const sequence = forward ? layerNumbers : [...layerNumbers].reverse();
    for (const layer of sequence) {
      const row = layers.get(layer)!;
      row.sort((left, right) => {
        const leftNeighbors = (forward ? incoming : outgoing).get(left.id) ?? [];
        const rightNeighbors = (forward ? incoming : outgoing).get(right.id) ?? [];
        return average(leftNeighbors.map(id => orderInLayer.get(id)).filter((v): v is number => v !== undefined))
          - average(rightNeighbors.map(id => orderInLayer.get(id)).filter((v): v is number => v !== undefined))
          || (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
      });
      row.forEach((node, index) => orderInLayer.set(node.id, index));
    }
  }

  const widest = Math.max(...layerNumbers.map(layer => layers.get(layer)!.length));
  const canvasWidth = widest * NODE_WIDTH + Math.max(0, widest - 1) * HORIZONTAL_GAP;
  let y = TOP;
  for (const layer of layerNumbers) {
    const row = layers.get(layer)!;
    const rowWidth = row.length * NODE_WIDTH + Math.max(0, row.length - 1) * HORIZONTAL_GAP;
    const offset = (canvasWidth - rowWidth) / 2;
    const rowHeight = Math.max(...row.map(estimatedNodeHeight));
    row.forEach((node, index) => {
      node.position = { x: LEFT + offset + index * (NODE_WIDTH + HORIZONTAL_GAP), y };
    });
    y += rowHeight + VERTICAL_GAP;
  }
  return nodes;
}

export function validateGeneratedDiagramGeometry(nodes: readonly GeneratedDiagramLayoutNode[]): string | null {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!Number.isFinite(left.position.x) || !Number.isFinite(left.position.y)) return 'Diagram node position is invalid.';
    const leftHeight = estimatedNodeHeight(left);
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      const rightHeight = estimatedNodeHeight(right);
      const separated = left.position.x + NODE_WIDTH + 24 <= right.position.x
        || right.position.x + NODE_WIDTH + 24 <= left.position.x
        || left.position.y + leftHeight + 24 <= right.position.y
        || right.position.y + rightHeight + 24 <= left.position.y;
      if (!separated) return `Diagram nodes ${left.id} and ${right.id} overlap.`;
    }
  }
  return null;
}

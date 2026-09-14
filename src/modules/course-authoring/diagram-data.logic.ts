export type CanonicalDiagramNode = {
  id: string;
  type: 'customShape' | 'junction';
  position: { x: number; y: number };
  data: Record<string, unknown>;
  [key: string]: unknown;
};

export type CanonicalDiagramEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type: string;
  [key: string]: unknown;
};

export type CanonicalDiagram = {
  id: string;
  name: string;
  nodes: CanonicalDiagramNode[];
  edges: CanonicalDiagramEdge[];
};

export type CanonicalDiagramData = {
  diagrams: CanonicalDiagram[];
  start_diagram_id: string;
};

const MAX_DIAGRAMS = 32;
const MAX_NODES_PER_DIAGRAM = 200;
const MAX_EDGES_PER_DIAGRAM = 400;
const VALID_POSITIONS = new Set(['top', 'left', 'bottom', 'right']);

export class DiagramDataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramDataValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new DiagramDataValidationError('Dữ liệu biểu đồ không phải JSON hợp lệ.');
  }
}

function unwrap(value: unknown): unknown {
  let current = parseJson(value);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current) || !('diagram_data' in current)) return current;
    current = parseJson(current.diagram_data);
  }
  return current;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function baseHandle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/-(?:source|target)$/, '');
  return VALID_POSITIONS.has(normalized) ? normalized : undefined;
}

function normalizeHandle(value: unknown, nodeType: string, role: 'source' | 'target'): string | undefined {
  const base = baseHandle(value);
  if (!base) return undefined;
  if (nodeType !== 'junction') return base;
  const allowed = role === 'source' ? ['bottom', 'right'] : ['top', 'left'];
  return allowed.includes(base) ? `${base}-${role}` : undefined;
}

function fallbackHandles(source: CanonicalDiagramNode, target: CanonicalDiagramNode): { sourceHandle: string; targetHandle: string } {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  const sourcePosition = Math.abs(dx) >= Math.abs(dy)
    ? (dx >= 0 ? 'right' : 'left')
    : (dy >= 0 ? 'bottom' : 'top');
  const targetPosition = sourcePosition === 'right'
    ? 'left'
    : sourcePosition === 'left'
      ? 'right'
      : sourcePosition === 'bottom'
        ? 'top'
        : 'bottom';
  const safeSourcePosition = source.type === 'junction' && !['bottom', 'right'].includes(sourcePosition)
    ? 'right'
    : sourcePosition;
  const safeTargetPosition = target.type === 'junction' && !['top', 'left'].includes(targetPosition)
    ? 'top'
    : targetPosition;
  return {
    sourceHandle: normalizeHandle(safeSourcePosition, source.type, 'source')!,
    targetHandle: normalizeHandle(safeTargetPosition, target.type, 'target')!,
  };
}

function normalizeNode(value: unknown, index: number): CanonicalDiagramNode {
  if (!isRecord(value)) {
    throw new DiagramDataValidationError(`Node biểu đồ thứ ${index + 1} không hợp lệ.`);
  }
  const id = String(value.id ?? `node-${index + 1}`).trim();
  if (!id || id.length > 120) {
    throw new DiagramDataValidationError(`Node biểu đồ thứ ${index + 1} thiếu mã hợp lệ.`);
  }
  const type = value.type === 'junction' ? 'junction' : 'customShape';
  const rawData = isRecord(value.data) ? value.data : {};
  const data: Record<string, unknown> = {
    ...rawData,
    label: String(rawData.label ?? value.label ?? '').trim(),
    shape: ['rectangle', 'rounded', 'ellipse'].includes(String(rawData.shape)) ? rawData.shape : 'rounded',
    bgColor: typeof rawData.bgColor === 'string' ? rawData.bgColor : '#ffffff',
    textColor: typeof rawData.textColor === 'string' ? rawData.textColor : '#000000',
  };
  return {
    ...value,
    id,
    type,
    position: {
      x: finiteNumber(isRecord(value.position) ? value.position.x : undefined, (index % 4) * 220),
      y: finiteNumber(isRecord(value.position) ? value.position.y : undefined, Math.floor(index / 4) * 120),
    },
    data,
  };
}

function normalizeEdge(
  value: unknown,
  index: number,
  nodesById: Map<string, CanonicalDiagramNode>,
): CanonicalDiagramEdge | null {
  if (!isRecord(value)) return null;
  const source = String(value.source ?? '').trim();
  const target = String(value.target ?? '').trim();
  if (!source || !target || source === target || !nodesById.has(source) || !nodesById.has(target)) return null;
  const sourceNode = nodesById.get(source)!;
  const targetNode = nodesById.get(target)!;
  const fallback = fallbackHandles(sourceNode, targetNode);
  const sourceHandle = normalizeHandle(value.sourceHandle, sourceNode.type, 'source') ?? fallback.sourceHandle;
  const targetHandle = normalizeHandle(value.targetHandle, targetNode.type, 'target') ?? fallback.targetHandle;
  const type = typeof value.type === 'string' && ['deletable', 'orthogonal', 'default', 'smoothstep', 'step'].includes(value.type)
    ? value.type
    : 'deletable';
  return {
    ...value,
    id: String(value.id ?? `edge-${index + 1}`).trim() || `edge-${index + 1}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    type,
  };
}

export function normalizeDiagramData(value: unknown): CanonicalDiagramData {
  const raw = unwrap(value);
  if (!isRecord(raw) || !Array.isArray(raw.diagrams)) {
    throw new DiagramDataValidationError('Dữ liệu biểu đồ phải có danh sách diagrams.');
  }
  if (raw.diagrams.length > MAX_DIAGRAMS) {
    throw new DiagramDataValidationError('Biểu đồ vượt quá số lượng sơ đồ cho phép.');
  }

  const diagrams: CanonicalDiagram[] = raw.diagrams.map((diagramValue, diagramIndex) => {
    if (!isRecord(diagramValue)) {
      throw new DiagramDataValidationError(`Sơ đồ thứ ${diagramIndex + 1} không hợp lệ.`);
    }
    const rawNodes = Array.isArray(diagramValue.nodes) ? diagramValue.nodes : [];
    const rawEdges = Array.isArray(diagramValue.edges) ? diagramValue.edges : [];
    if (rawNodes.length > MAX_NODES_PER_DIAGRAM || rawEdges.length > MAX_EDGES_PER_DIAGRAM) {
      throw new DiagramDataValidationError(`Sơ đồ thứ ${diagramIndex + 1} vượt quá giới hạn node hoặc edge.`);
    }
    const nodes = rawNodes.map(normalizeNode);
    const nodeIds = new Set<string>();
    nodes.forEach((node, nodeIndex) => {
      if (nodeIds.has(node.id)) {
        throw new DiagramDataValidationError(`Sơ đồ thứ ${diagramIndex + 1} có node trùng mã ở vị trí ${nodeIndex + 1}.`);
      }
      nodeIds.add(node.id);
    });
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const edgeIds = new Set<string>();
    const edges = rawEdges
      .map((edge, edgeIndex) => normalizeEdge(edge, edgeIndex, nodesById))
      .filter((edge): edge is CanonicalDiagramEdge => Boolean(edge))
      .map((edge, edgeIndex) => {
        let id = edge.id;
        while (edgeIds.has(id)) id = `${edge.id}-${edgeIndex + 1}`;
        edgeIds.add(id);
        return { ...edge, id };
      });
    return {
      ...diagramValue,
      id: String(diagramValue.id ?? `diagram-${diagramIndex + 1}`).trim() || `diagram-${diagramIndex + 1}`,
      name: String(diagramValue.name ?? `Sơ đồ ${diagramIndex + 1}`).trim() || `Sơ đồ ${diagramIndex + 1}`,
      nodes,
      edges,
    };
  });

  const diagramIds = new Set<string>();
  diagrams.forEach((diagram, index) => {
    if (diagramIds.has(diagram.id)) {
      throw new DiagramDataValidationError(`Danh sách sơ đồ có mã trùng ở vị trí ${index + 1}.`);
    }
    diagramIds.add(diagram.id);
  });
  const requestedStart = String(raw.start_diagram_id ?? '').trim();
  return {
    diagrams,
    start_diagram_id: requestedStart && diagramIds.has(requestedStart) ? requestedStart : (diagrams[0]?.id ?? ''),
  };
}

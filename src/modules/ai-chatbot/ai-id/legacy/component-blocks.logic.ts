// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { assertComponentInstancePlan } from '../../lesson-author-capabilities.logic.js';
import {
  getLessonAuthorSortableItems,
  orderLessonAuthorComponents,
  type LessonAuthorComponentProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { renderSemanticLearningHtml } from '../../lesson-author-component-registry.logic.js';
import { layoutGeneratedDiagramNodes, normalizeDiagramDisplayText } from '../../lesson-author-diagram-layout.logic.js';
import { MIN_UNIT_HTML_TEXT_CHARS, MAX_COMPONENTS_PER_UNIT } from './constants.js';
import {
  asRecord,
  readString,
  normalizeComponentTitle,
  mergeNestedLessonAuthorContent,
  normalizeComponentType,
  getLessonAuthorComponentProvenance,
  sanitizeGeneratedHtml,
  normalizeProblemComponent,
} from './component-normalize.logic.js';
import { foldVietnameseText } from './context.service.js';

function normalizeFaqComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawItems = Array.isArray(component.items) ? component.items : [];
  const items = rawItems
    .map((itemValue, index) => {
      const item = asRecord(itemValue);
      return {
        id: index + 1,
        question: readString(item.question ?? item.q, '', 500),
        answer: readString(item.answer ?? item.a ?? item.content, '', 2000),
      };
    })
    .filter(item => item.question && item.answer)
    .slice(0, 8);

  if (items.length < 2) throw new Error('FAQ component requires at least 2 Q&A items');

  const faqData = { items };
  return {
    type: 'la_faq',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { faq_data: JSON.stringify(faqData) },
    metadata: { faq_data: faqData },
  };
}

function normalizeSortableComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawItems = getLessonAuthorSortableItems(component);
  const items = rawItems
    .map((itemValue, index) => {
      const item = asRecord(itemValue);
      const text = typeof itemValue === 'string'
        ? readString(itemValue, '', 500)
        : readString(item.text ?? item.label ?? item.title, '', 500);
      return { id: index + 1, text };
    })
    .filter(item => item.text)
    .slice(0, 10);

  if (items.length < 3) throw new Error('Sortable component requires at least 3 ordered items');

  const questionText = readString(
    component.question_text ?? component.question ?? component.prompt,
    'Sap xep cac muc theo dung thu tu.',
    500,
  );
  const sortableData = { items };
  return {
    type: 'la_sortable',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { question_text: questionText, sortable_data: JSON.stringify(sortableData) },
    metadata: { question_text: questionText, sortable_data: sortableData },
  };
}

function normalizeCrosswordAnswer(value: unknown): string {
  return readString(value, '', 80)
    .replace(/đ/gi, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

function normalizeCrosswordComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawWords = Array.isArray(component.words) ? component.words : [];
  const words = rawWords
    .map((wordValue, index) => {
      const word = asRecord(wordValue);
      const answer = normalizeCrosswordAnswer(word.answer ?? word.term ?? word.text);
      return {
        id: index + 1,
        answer,
        clue: readString(word.clue ?? word.definition ?? word.hint, '', 500),
        hint: readString(word.hint, '', 500),
        row: index,
        col: 0,
        direction: 'across',
      };
    })
    .filter(word => word.answer.length >= 2 && word.clue)
    .slice(0, 10);

  if (words.length < 3) throw new Error('Crossword component requires at least 3 valid words');

  const crosswordData = { words, keyword_coordinates: [] };
  return {
    type: 'la_crossword',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { crossword_data: JSON.stringify(crosswordData) },
    metadata: { crossword_data: crosswordData },
  };
}

function normalizeDiagramShape(value: unknown): 'rectangle' | 'rounded' | 'ellipse' {
  const shape = readString(value, 'rounded', 40).toLowerCase();
  if (shape === 'rectangle' || shape === 'rounded' || shape === 'ellipse') return shape;
  if (shape === 'circle' || shape === 'oval') return 'ellipse';
  return 'rounded';
}

const DIAGRAM_NODE_STYLES = [
  { bgColor: '#EEF2FF', textColor: '#3730A3', icon: '🎯' },
  { bgColor: '#E0F2FE', textColor: '#075985', icon: '💡' },
  { bgColor: '#DCFCE7', textColor: '#166534', icon: '✅' },
  { bgColor: '#FEF3C7', textColor: '#92400E', icon: '⚙️' },
  { bgColor: '#FCE7F3', textColor: '#9D174D', icon: '📊' },
  { bgColor: '#EDE9FE', textColor: '#5B21B6', icon: '🧩' },
  { bgColor: '#CCFBF1', textColor: '#115E59', icon: '🔍' },
  { bgColor: '#FFE4E6', textColor: '#9F1239', icon: '🚀' },
];

function normalizeDiagramNodeColor(index: number): string {
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].bgColor;
}

function normalizeDiagramTextColor(index: number): string {
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].textColor;
}

function labelAlreadyHasIcon(label: string): boolean {
  const firstChar = Array.from(label.trim())[0] ?? '';
  const codePoint = firstChar.codePointAt(0) ?? 0;
  return codePoint >= 0x2190 && codePoint <= 0x1FAFF;
}

function chooseDiagramNodeIcon(label: string, index: number): string {
  const folded = foldVietnameseText(label);
  if (/(^|\b)(muc tieu|goal|objective|outcome|ket qua)(\b|$)/i.test(folded)) return '🎯';
  if (/(^|\b)(khai niem|concept|dinh nghia|definition|y tuong|idea|ly thuyet)(\b|$)/i.test(folded)) return '💡';
  if (/(^|\b)(quy trinh|process|flow|workflow|buoc|step|giai doan|stage)(\b|$)/i.test(folded)) return '⚙️';
  if (/(^|\b)(du lieu|data|chi so|metric|kpi|bao cao|report|so lieu)(\b|$)/i.test(folded)) return '📊';
  if (/(^|\b)(nguoi hoc|learner|khach hang|customer|user|team|nhom|doi ngu)(\b|$)/i.test(folded)) return '👥';
  if (/(^|\b)(rui ro|risk|loi|error|van de|problem|thach thuc|challenge)(\b|$)/i.test(folded)) return '⚠️';
  if (/(^|\b)(giai phap|solution|ket luan|conclusion|thanh cong|success|hoan thanh)(\b|$)/i.test(folded)) return '✅';
  if (/(^|\b)(cong cu|tool|he thong|system|api|nen tang|platform|ky thuat)(\b|$)/i.test(folded)) return '🛠️';
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].icon;
}

function formatDiagramNodeLabel(label: string, index: number): string {
  const cleanLabel = normalizeDiagramDisplayText(label, 120);
  if (!cleanLabel || labelAlreadyHasIcon(cleanLabel)) return cleanLabel.slice(0, 120);
  return `${chooseDiagramNodeIcon(cleanLabel, index)} ${cleanLabel}`.slice(0, 140);
}

function getDiagramEdgeHandles(
  sourcePosition: { x: number; y: number },
  targetPosition: { x: number; y: number },
  routing: 'orthogonal' | 'feedback' = 'orthogonal',
): { sourceHandle: 'top' | 'right' | 'bottom' | 'left'; targetHandle: 'top' | 'right' | 'bottom' | 'left' } {
  if (routing === 'feedback') {
    return { sourceHandle: 'right', targetHandle: 'right' };
  }
  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

function generatedDiagramEdgeLabel(edge: Record<string, unknown>): string {
  const value = edge.label ?? (asRecord(edge.data).label);
  return normalizeDiagramDisplayText(value, 120).toLocaleLowerCase();
}

function removeRedundantGeneratedEdges<T extends { source: string; target: string }>(edges: T[]): T[] {
  const acceptedByDirection = new Map<string, T>();
  const result: T[] = [];

  for (const edge of edges) {
    const direction = `${edge.source}->${edge.target}`;
    if (acceptedByDirection.has(direction)) continue;

    const reverse = acceptedByDirection.get(`${edge.target}->${edge.source}`);
    if (reverse) {
      const currentLabel = generatedDiagramEdgeLabel(edge as Record<string, unknown>);
      const reverseLabel = generatedDiagramEdgeLabel(reverse as Record<string, unknown>);
      if (!currentLabel || !reverseLabel || currentLabel === reverseLabel) continue;
    }

    acceptedByDirection.set(direction, edge);
    result.push(edge);
  }

  return result;
}

function limitGeneratedEdges<T extends { source: string; target: string }>(
  edges: T[],
  maxEdges: number,
): T[] {
  const selected: T[] = [];
  const selectedDirections = new Set<string>();
  const hasIncoming = new Set<string>();

  // Preserve at least one incoming relationship for every reachable node so
  // truncation never turns a connected authoring result into a random fragment.
  for (const edge of edges) {
    if (hasIncoming.has(edge.target) || selected.length >= maxEdges) continue;
    selected.push(edge);
    selectedDirections.add(`${edge.source}->${edge.target}`);
    hasIncoming.add(edge.target);
  }

  for (const edge of edges) {
    if (selected.length >= maxEdges) break;
    const direction = `${edge.source}->${edge.target}`;
    if (selectedDirections.has(direction)) continue;
    selected.push(edge);
    selectedDirections.add(direction);
  }

  return selected;
}

function resolveDiagramNodeRef(value: unknown, nodes: Array<{ id: string; label: string }>): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    // The authoring prompt uses zero-based indexes. Keep one-based indexes as
    // a compatibility fallback for older proposals, but never resolve beyond
    // the canonical node list.
    if (value >= 0 && value < nodes.length) return nodes[value]?.id ?? null;
    if (value > 0 && value <= nodes.length) return nodes[value - 1]?.id ?? null;
    return null;
  }

  const raw = readString(value, '', 180);
  if (!raw) return null;
  const direct = nodes.find(node => node.id === raw);
  if (direct) return direct.id;

  const normalized = raw.trim().toLowerCase();
  return nodes.find(node => node.label.trim().toLowerCase() === normalized)?.id ?? null;
}

function normalizeDiagramComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawNodes = Array.isArray(component.nodes) ? component.nodes : [];
  const nodeRefs: Array<{ id: string; label: string }> = [];
  const nodes = rawNodes
    .map((nodeValue, index) => {
      const node = asRecord(nodeValue);
      const label = normalizeDiagramDisplayText(typeof nodeValue === 'string'
        ? readString(nodeValue, '', 120)
        : readString(node.label ?? node.title ?? node.name, '', 120), 120);
      if (!label) return null;

      const id = `node_${index + 1}`;
      nodeRefs.push({ id, label });
      const bgColor = readString(node.bgColor ?? node.bg_color, normalizeDiagramNodeColor(index), 24);
      return {
        id,
        type: 'customShape',
        position: { x: 80, y: 70 },
        data: {
          label: formatDiagramNodeLabel(label, index),
          shape: normalizeDiagramShape(node.shape ?? (index === 0 ? 'ellipse' : 'rounded')),
          bgColor,
          textColor: readString(node.textColor ?? node.text_color, normalizeDiagramTextColor(index), 24),
          tooltip: normalizeDiagramDisplayText(readString(node.tooltip ?? node.description ?? node.summary, label, 500), 500),
          target_diagram_id: '',
        },
      };
    })
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .slice(0, 12);

  if (nodes.length < 2) throw new Error('Diagram component requires at least 2 nodes');

  // Resolve edges only against nodes that will actually be persisted. This
  // prevents an edge from pointing at a node removed by the twelve-node cap.
  const availableNodeRefs = nodeRefs.slice(0, nodes.length);
  const rawEdges = Array.isArray(component.edges) ? component.edges : [];
  const seenConnections = new Set<string>();
  const maxReadableEdges = Math.max(1, Math.min(16, nodes.length + 2));
  const explicitEdges = removeRedundantGeneratedEdges(rawEdges
    .map((edgeValue, index) => {
      const edge = asRecord(edgeValue);
      const source = resolveDiagramNodeRef(edge.source ?? edge.from, availableNodeRefs);
      const target = resolveDiagramNodeRef(edge.target ?? edge.to, availableNodeRefs);
      if (!source || !target || source === target) return null;
      const connectionKey = `${source}->${target}`;
      if (seenConnections.has(connectionKey)) return null;
      seenConnections.add(connectionKey);
      return {
        id: `edge_${index + 1}`,
        source,
        target,
        sourceHandle: 'right' as const,
        targetHandle: 'left' as const,
        type: 'deletable',
        label: normalizeDiagramDisplayText(readString(edge.label, '', 120), 120) || undefined,
        style: { stroke: '#64748B', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', color: '#64748B' },
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  );
  const readableEdges = limitGeneratedEdges(
    explicitEdges,
    maxReadableEdges,
  );

  const initialEdges = readableEdges.length > 0
    ? readableEdges
    : nodes.slice(1).map((node, index) => ({
      id: `edge_${index + 1}`,
      source: nodes[index].id,
      target: node.id,
      sourceHandle: 'right' as const,
      targetHandle: 'left' as const,
      type: 'deletable',
      style: { stroke: '#64748B', strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed', color: '#64748B' },
    }));
  const positionedNodes = layoutGeneratedDiagramNodes(nodes, initialEdges);
  const nodeById = new Map(positionedNodes.map(node => [node.id, node]));
  const edges = initialEdges.map(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const routing = source && target && target.position.y < source.position.y - 1
      ? 'feedback'
      : 'orthogonal';
    const handles = source && target
      ? getDiagramEdgeHandles(source.position, target.position, routing)
      : { sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
    return {
      ...edge,
      ...handles,
      data: {
        ...asRecord((edge as { data?: unknown }).data),
        routing,
        feedbackSide: 'right',
      },
    };
  });

  const diagramId = 'root';
  const diagramData = {
    diagrams: [{
      id: diagramId,
      name: normalizeDiagramDisplayText(readString(component.name ?? component.title, 'Main Diagram', 120), 120),
      nodes: positionedNodes,
      edges,
    }],
    start_diagram_id: diagramId,
  };

  return {
    type: 'la_diagram',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { diagram_data: JSON.stringify(diagramData) },
    metadata: { diagram_data: diagramData },
  };
}

function normalizeLessonAuthorComponent(componentValue: unknown, fallbackTitle: string): LessonAuthorComponentProposal {
  const component = mergeNestedLessonAuthorContent(asRecord(componentValue));
  const type = normalizeComponentType(component.type ?? component.block_type);
  if (!type) throw new Error(`Unsupported component type: ${readString(component.type, 'unknown', 40)}`);

  const attachProvenance = (normalized: LessonAuthorComponentProposal): LessonAuthorComponentProposal => {
    const provenance = getLessonAuthorComponentProvenance(component);
    return Object.keys(provenance).length > 0
      ? { ...normalized, metadata: { ...(normalized.metadata ?? {}), ...provenance } }
      : normalized;
  };

  if (type === 'html') {
    const deterministicHtml = renderSemanticLearningHtml(
      component.semantic_content ?? component.semanticContent ?? component.structured_content,
    );
    return attachProvenance({
      type: 'html',
      title: normalizeComponentTitle(component.title, fallbackTitle),
      data: sanitizeGeneratedHtml(
        deterministicHtml ?? component.html ?? component.data ?? component.content,
        component.source_locked_fallback === true ? 1 : MIN_UNIT_HTML_TEXT_CHARS,
      ),
      ...(deterministicHtml ? { metadata: { html_renderer: 'semantic_deterministic' } } : {}),
    });
  }
  if (type === 'problem') return attachProvenance(normalizeProblemComponent(component, fallbackTitle));
  if (type === 'la_faq') return attachProvenance(normalizeFaqComponent(component, fallbackTitle));
  if (type === 'la_sortable') return attachProvenance(normalizeSortableComponent(component, fallbackTitle));
  if (type === 'la_crossword') return attachProvenance(normalizeCrosswordComponent(component, fallbackTitle));
  return attachProvenance(normalizeDiagramComponent(component, fallbackTitle));
}

export function normalizeLessonAuthorUnitComponents(unit: Record<string, unknown>, unitTitle: string): LessonAuthorComponentProposal[] {
  const normalizedUnit = mergeNestedLessonAuthorContent(unit);
  const rawComponents = Array.isArray(normalizedUnit.components)
    ? normalizedUnit.components
    : Array.isArray(normalizedUnit.blocks)
      ? normalizedUnit.blocks
      : [];

  const rawInstanceIds = rawComponents.map(value => {
    const component = asRecord(value);
    return { component_plan_id: (component.component_plan_id ?? asRecord(component.metadata).component_plan_id) as string | undefined };
  });
  if (rawInstanceIds.some(value => value.component_plan_id != null)) {
    assertComponentInstancePlan(rawInstanceIds);
  }

  const components = rawComponents
    .slice(0, MAX_COMPONENTS_PER_UNIT)
    .map((componentValue, componentIndex) => normalizeLessonAuthorComponent(
      componentValue,
      `${unitTitle} component ${componentIndex + 1}`,
    ));

  if (components.length > 0) return orderLessonAuthorComponents(components);

  const fallbackHtml = typeof normalizedUnit.html === 'string'
    ? normalizedUnit.html
    : typeof normalizedUnit.content === 'string'
      ? normalizedUnit.content
      : '';
  if (fallbackHtml.trim()) {
    return [{
      type: 'html',
      title: unitTitle,
      data: sanitizeGeneratedHtml(fallbackHtml),
    }];
  }

  throw new Error(`Unit "${unitTitle}" must contain at least one valid component`);
}

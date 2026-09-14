import assert from 'node:assert/strict';
import test from 'node:test';
import { orderLessonAuthorComponents } from './lesson-author-components.logic.js';
import type { LessonAuthorComponentProposal } from './course-authoring.service.js';
import { normalizeDiagramData } from './diagram-data.logic.js';

function component(type: LessonAuthorComponentProposal['type'], title: string): LessonAuthorComponentProposal {
  return { type, title, data: null };
}

test('FAQ blocks are moved to the end while preserving stable order', () => {
  const ordered = orderLessonAuthorComponents([
    component('la_faq', 'FAQ 1'),
    component('html', 'Giải thích'),
    component('la_diagram', 'Sơ đồ'),
    component('la_faq', 'FAQ 2'),
    component('problem', 'Bài kiểm tra'),
  ]);

  assert.deepEqual(ordered.map(item => item.title), [
    'Giải thích',
    'Sơ đồ',
    'Bài kiểm tra',
    'FAQ 1',
    'FAQ 2',
  ]);
});

test('component order is unchanged when a unit has no FAQ', () => {
  const components = [component('html', 'A'), component('problem', 'B')];
  assert.deepEqual(orderLessonAuthorComponents(components), components);
});

test('diagram data normalizes legacy JSON and repairs compatible edge handles', () => {
  const normalized = normalizeDiagramData({
    diagram_data: JSON.stringify({
      diagrams: [{
        id: 'main',
        nodes: [
          { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A', shape: 'rounded' } },
          { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B', shape: 'rounded' } },
        ],
        edges: [{ id: 'edge-1', source: 'a', target: 'b', sourceHandle: 'right-source', targetHandle: 'left-target' }],
      }],
      start_diagram_id: 'main',
    }),
  });

  assert.equal(normalized.start_diagram_id, 'main');
  assert.equal(normalized.diagrams[0].nodes[0].type, 'customShape');
  assert.equal(normalized.diagrams[0].edges[0].sourceHandle, 'right');
  assert.equal(normalized.diagrams[0].edges[0].targetHandle, 'left');
});

test('diagram data drops edges that point to deleted nodes without dropping the diagram', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }],
      edges: [{ id: 'orphan', source: 'a', target: 'missing' }],
    }],
  });

  assert.equal(normalized.diagrams[0].edges.length, 0);
  assert.equal(normalized.start_diagram_id, 'main');
});

test('diagram data respects junction input and output ports', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'junction', type: 'junction', position: { x: 100, y: 100 }, data: {} },
        { id: 'target', position: { x: 0, y: 100 }, data: { label: 'Target' } },
      ],
      edges: [{ source: 'junction', target: 'target', sourceHandle: 'top', targetHandle: 'right' }],
    }],
  });

  assert.equal(normalized.diagrams[0].edges[0].sourceHandle, 'right-source');
  assert.equal(normalized.diagrams[0].edges[0].targetHandle, 'right');
});

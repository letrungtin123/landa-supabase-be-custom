import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLessonAuthorSortableItems,
  isLessonAuthorGeneratedContentOwned,
  isLessonAuthorMediaProtectedBlock,
  orderLessonAuthorComponents,
} from './lesson-author-components.logic.js';
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

test('lesson author ownership requires explicit generated metadata', () => {
  assert.equal(isLessonAuthorGeneratedContentOwned({ generated_by: 'lesson_author_ai' }), true);
  assert.equal(isLessonAuthorGeneratedContentOwned({ generated_by: 'manual' }), false);
  assert.equal(isLessonAuthorGeneratedContentOwned(null), false);
});

test('media-bearing blocks are protected from lesson author replacement', () => {
  assert.equal(isLessonAuthorMediaProtectedBlock('video', {}, {}), true);
  assert.equal(isLessonAuthorMediaProtectedBlock('la_image_choice_quiz', {}, {}), true);
  assert.equal(isLessonAuthorMediaProtectedBlock('html', '<p>Nội dung</p><img src="asset.png">', {}), true);
  assert.equal(isLessonAuthorMediaProtectedBlock('html', '<p>Nội dung thuần văn bản</p>', {
    html_media: { images: [{ storage_path: 'tenant/course/image.png' }] },
  }), true);
  assert.equal(isLessonAuthorMediaProtectedBlock('problem', {}, {
    problem_media: { video_storage_path: 'tenant/course/video.mp4' },
  }), true);
  assert.equal(isLessonAuthorMediaProtectedBlock('html', '<p>Nội dung thuần văn bản</p>', {
    generated_by: 'lesson_author_ai',
    html_media: { images: [] },
  }), false);
});

test('sortable contract accepts items, ordered_items, and steps aliases', () => {
  assert.deepEqual(getLessonAuthorSortableItems({ items: ['A', 'B', 'C'] }), ['A', 'B', 'C']);
  assert.deepEqual(getLessonAuthorSortableItems({ ordered_items: ['A', 'B', 'C'] }), ['A', 'B', 'C']);
  assert.deepEqual(getLessonAuthorSortableItems({ steps: ['A', 'B', 'C'] }), ['A', 'B', 'C']);
  assert.deepEqual(getLessonAuthorSortableItems({ ordered_items: 'A, B, C' }), []);
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
        edges: [{ id: 'edge-1', source: 'a', target: 'b', sourceHandle: 'right-source', targetHandle: 'left-target', markerStart: { type: 'arrowclosed' } }],
      }],
      start_diagram_id: 'main',
    }),
  });

  assert.equal(normalized.start_diagram_id, 'main');
  assert.equal(normalized.diagrams[0].nodes[0].type, 'customShape');
  assert.equal(normalized.diagrams[0].edges[0].sourceHandle, 'right');
  assert.equal(normalized.diagrams[0].edges[0].targetHandle, 'left');
  assert.equal(normalized.diagrams[0].edges[0].markerStart, undefined);
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

test('diagram data preserves selected ports for an upward connection', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'lower', position: { x: 0, y: 200 }, data: { label: 'Lower' } },
        { id: 'upper', position: { x: 240, y: 0 }, data: { label: 'Upper' } },
      ],
      edges: [{ source: 'lower', target: 'upper', sourceHandle: 'left', targetHandle: 'bottom' }],
    }],
  });

  const edge = normalized.diagrams[0].edges[0];
  assert.equal(edge.sourceHandle, 'left');
  assert.equal(edge.targetHandle, 'bottom');
  assert.equal((edge.data as Record<string, unknown>).routing, 'orthogonal');
});

test('diagram data preserves parallel and reverse relationships while dropping self-loops', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B' } },
        { id: 'c', position: { x: 480, y: 0 }, data: { label: 'C' } },
      ],
      edges: [
        { id: 'a-b-1', source: 'a', target: 'b' },
        { id: 'a-b-2', source: 'a', target: 'b' },
        { id: 'b-a', source: 'b', target: 'a' },
        { id: 'b-b', source: 'b', target: 'b' },
        { id: 'b-c', source: 'b', target: 'c' },
      ],
    }],
  });

  assert.deepEqual(
    normalized.diagrams[0].edges.map(edge => `${edge.source}->${edge.target}`),
    ['a->b', 'a->b', 'b->a', 'b->c'],
  );
});

test('diagram data preserves a labelled bidirectional relationship when labels differ', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B' } },
      ],
      edges: [
        { id: 'a-b', source: 'a', target: 'b', label: 'gửi' },
        { id: 'b-a', source: 'b', target: 'a', label: 'nhận' },
      ],
    }],
  });

  assert.equal(normalized.diagrams[0].edges.length, 2);
});

test('diagram edge appearance preserves the four supported combinations and color', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B' } },
      ],
      edges: [{
        id: 'edge-1',
        source: 'a',
        target: 'b',
        markerEnd: { type: 'arrowclosed' },
        data: { appearance: { lineStyle: 'dashed', arrow: 'none', color: '#dc2626' } },
      }],
    }],
  });

  const edge = normalized.diagrams[0].edges[0];
  const edgeData = edge.data as Record<string, any>;
  assert.deepEqual(edgeData.appearance, {
    lineStyle: 'dashed',
    arrow: 'none',
    color: '#DC2626',
  });
  assert.equal(edge.markerEnd, undefined);
  assert.equal(edge.markerStart, undefined);
  assert.equal((edge.style as Record<string, unknown>).stroke, '#DC2626');
  assert.equal((edge.style as Record<string, unknown>).strokeDasharray, '6 4');
});

test('diagram edge appearance sanitizes invalid values and keeps legacy arrows', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B' } },
      ],
      edges: [{
        id: 'edge-1',
        source: 'a',
        target: 'b',
        data: { appearance: { lineStyle: 'unknown', arrow: 'unknown', color: 'var(--primary)' } },
      }],
    }],
  });

  const edge = normalized.diagrams[0].edges[0];
  const edgeData = edge.data as Record<string, any>;
  assert.deepEqual(edgeData.appearance, {
    lineStyle: 'solid',
    arrow: 'end',
    color: '#64748B',
  });
  assert.equal((edge.markerEnd as Record<string, unknown>).type, 'arrowclosed');
  assert.equal((edge.markerEnd as Record<string, unknown>).color, '#64748B');
  assert.equal((edge.style as Record<string, unknown>).strokeDasharray, undefined);
});

test('legacy feedback edges remain dashed and preserve their visible arrow', () => {
  const normalized = normalizeDiagramData({
    diagrams: [{
      id: 'main',
      nodes: [
        { id: 'a', position: { x: 0, y: 100 }, data: { label: 'A' } },
        { id: 'b', position: { x: 240, y: 0 }, data: { label: 'B' } },
      ],
      edges: [{ id: 'feedback', source: 'a', target: 'b', label: 'Phản hồi', data: { routing: 'feedback' } }],
    }],
  });

  const edge = normalized.diagrams[0].edges[0];
  const edgeData = edge.data as Record<string, any>;
  assert.equal(edgeData.routing, 'feedback');
  assert.equal((edgeData.appearance as Record<string, unknown>).lineStyle, 'dashed');
  assert.equal((edgeData.appearance as Record<string, unknown>).color, '#2563EB');
  assert.equal((edge.markerEnd as Record<string, unknown>).type, 'arrowclosed');
});

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
import { readFileSync } from 'node:fs';
import { applyGeneratedUnitComponents, ComponentApplyError,
  type GeneratedComponentWrite, type StoredComponentRow, type UnitComponentStore } from './lesson-author-component-apply.logic.js';

function instance(index: number, overrides: Partial<GeneratedComponentWrite> = {}): GeneratedComponentWrite {
  return { blockType: 'problem', displayName: 'Câu hỏi kiểm tra', data: `<problem>Question ${index}</problem>`,
    metadata: { component_plan_id: `cp2_${index.toString(16).padStart(32, '0')}`, generated_by: 'lesson_author_ai',
      job_id: 'job-1', ai_component_index: index, supporting_evidence_fact_ids: [`fact-${index}`] }, ...overrides };
}

function memoryUnit(initial: StoredComponentRow[] = []) {
  const rows = structuredClone(initial);
  let writes = 0;
  const store: UnitComponentStore = {
    list: async () => structuredClone(rows),
    insert: async c => {
      writes++;
      const id = `new-${writes}`;
      rows.push({ id, block_type: c.blockType, display_name: c.displayName, data: structuredClone(c.data), metadata: structuredClone(c.metadata) });
      return id;
    },
    update: async (id, c) => {
      writes++;
      const row = rows.find(r => r.id === id)!;
      row.data = structuredClone(c.data);
      row.metadata = { ...(row.metadata as object), ...structuredClone(c.metadata) };
    },
  };
  return { rows, store, writes: () => writes };
}

function stored(c: GeneratedComponentWrite, id = 'existing'): StoredComponentRow {
  return { id, block_type: c.blockType, display_name: c.displayName, data: c.data, metadata: c.metadata };
}

function applyCode(code: string) {
  return (error: unknown) => error instanceof ComponentApplyError && error.code === code;
}

test('Apply preserves two same-title problems with distinct instance IDs and payloads', async () => {
  const m = memoryUnit();
  const expected = [instance(0), instance(1)];
  const before = structuredClone(expected);
  const result = await applyGeneratedUnitComponents(expected, m.store);
  assert.equal(new Set(result.map(r => r.id)).size, 2);
  assert.deepEqual(m.rows.map(r => r.data), expected.map(c => c.data));
  assert.deepEqual(expected, before);
});

test('same instances reapply without duplicates even after a display title changes', async () => {
  const m = memoryUnit();
  const expected = [instance(0), instance(1)];
  const first = await applyGeneratedUnitComponents(expected, m.store);
  m.rows[0].display_name = 'A learner-friendly renamed question';
  const second = await applyGeneratedUnitComponents(expected, m.store);
  assert.deepEqual(second.map(r => r.id), first.map(r => r.id));
  assert.ok(second.every(r => r.updated));
  assert.equal(m.rows.length, 2);
});

test('11-unit regression retains all 15 problems instead of collapsing to 11', async () => {
  let storedProblems = 0;
  for (let unit = 0; unit < 11; unit++) {
    const m = memoryUnit();
    const count = unit < 4 ? 2 : 1;
    const problems = Array.from({ length: count }, (_, i) => instance(unit * 10 + i));
    await applyGeneratedUnitComponents(problems, m.store);
    storedProblems += m.rows.filter(r => r.block_type === 'problem').length;
  }
  assert.equal(storedProblems, 15);
});

test('instance lookup never falls back to same title in a different plan or legacy content', async () => {
  const old = instance(8);
  const legacy = instance(9, { metadata: { generated_by: 'lesson_author_ai' } });
  const m = memoryUnit([stored(old), stored(legacy, 'legacy')]);
  await applyGeneratedUnitComponents([instance(1)], m.store);
  assert.equal(m.rows.length, 3);
  assert.equal(m.rows[0].data, old.data);
  assert.equal(m.rows[1].data, legacy.data);
});

test('duplicate, malformed and mixed instance identities reject before writes', async () => {
  for (const items of [[instance(1), instance(1)], [instance(1, { metadata: { component_plan_id: '[bad]' } })],
    [instance(1), instance(2, { metadata: {} })]]) {
    const m = memoryUnit();
    await assert.rejects(applyGeneratedUnitComponents(items, m.store), applyCode('COMPONENT_APPLY_INSTANCE_INVALID'));
    assert.equal(m.writes(), 0);
  }
});

test('ambiguous stored ID or type mismatch rejects before writes', async () => {
  const m = memoryUnit([stored(instance(1), 'a'), stored(instance(1), 'b')]);
  await assert.rejects(applyGeneratedUnitComponents([instance(1)], m.store), applyCode('COMPONENT_APPLY_IDENTITY_AMBIGUOUS'));
  assert.equal(m.writes(), 0);
  const wrongType = memoryUnit([stored(instance(1, { blockType: 'html' }))]);
  await assert.rejects(applyGeneratedUnitComponents([instance(1)], wrongType.store), applyCode('COMPONENT_APPLY_IDENTITY_CONFLICT'));
  assert.equal(wrongType.writes(), 0);
});

test('exact instance cannot replace a manual or media-protected block', async () => {
  for (const row of [stored(instance(1, { metadata: { ...instance(1).metadata, generated_by: 'manual' } })),
    stored(instance(1, { metadata: { ...instance(1).metadata, problem_media: { image_storage_path: 'existing-asset' } } }))]) {
    const m = memoryUnit([row]);
    await assert.rejects(applyGeneratedUnitComponents([instance(1)], m.store), applyCode('COMPONENT_APPLY_PROTECTED_INSTANCE'));
    assert.equal(m.writes(), 0);
  }
});

test('legacy unique-title update remains supported without taking over an instance', async () => {
  const legacy = instance(1, { metadata: { generated_by: 'lesson_author_ai' } });
  const m = memoryUnit([stored(legacy), stored(instance(3), 'modern')]);
  const result = await applyGeneratedUnitComponents([{ ...legacy, data: 'New legacy content' }], m.store);
  assert.equal(result[0].id, 'existing');
  assert.equal(m.rows.length, 2);
  assert.equal(m.rows[1].data, instance(3).data);
});

test('legacy same-title siblings stay distinct and support same-job replay', async () => {
  const legacy = [0, 1].map(i => instance(i, { metadata: { generated_by: 'lesson_author_ai', job_id: 'legacy-job', ai_component_index: i } }));
  const m = memoryUnit();
  const first = await applyGeneratedUnitComponents(legacy, m.store);
  const second = await applyGeneratedUnitComponents(legacy, m.store);
  assert.equal(m.rows.length, 2);
  assert.deepEqual(first.map(r => r.id), second.map(r => r.id));
  assert.deepEqual(m.rows.map(r => r.data), legacy.map(c => c.data));
});

test('legacy title ambiguity fails closed and manual/media siblings remain unchanged', async () => {
  const legacy = instance(0, { metadata: { generated_by: 'lesson_author_ai' } });
  const ambiguous = memoryUnit([stored(legacy, 'a'), stored(legacy, 'b')]);
  await assert.rejects(applyGeneratedUnitComponents([legacy], ambiguous.store), applyCode('COMPONENT_APPLY_IDENTITY_AMBIGUOUS'));
  assert.equal(ambiguous.writes(), 0);
  const manual = stored({ ...legacy, metadata: { generated_by: 'manual' } });
  const protectedRow = stored({ ...legacy, metadata: { generated_by: 'lesson_author_ai', problem_media: { storage_path: 'existing' } } }, 'protected');
  const m = memoryUnit([manual, protectedRow]);
  await applyGeneratedUnitComponents([legacy], m.store);
  assert.deepEqual(m.rows.slice(0, 2), [manual, protectedRow]);
  assert.equal(m.rows.length, 3);
});

test('parity rejects persisted payload or evidence changes and missing writes', async () => {
  for (const fault of ['data', 'metadata', 'missing']) {
    const m = memoryUnit();
    const insert = m.store.insert;
    m.store.insert = async c => {
      const id = await insert(c);
      if (fault === 'data') m.rows[0].data = 'overwritten';
      if (fault === 'metadata') (m.rows[0].metadata as Record<string, unknown>).supporting_evidence_fact_ids = ['foreign'];
      if (fault === 'missing') m.rows.pop();
      return id;
    };
    await assert.rejects(applyGeneratedUnitComponents([instance(1)], m.store), applyCode('COMPONENT_APPLY_PARITY_FAILED'));
  }
});

test('parity catches adapter reusing one block for two components', async () => {
  const m = memoryUnit();
  m.store.insert = async c => { m.rows.splice(0, m.rows.length, stored(c, 'same')); return 'same'; };
  await assert.rejects(applyGeneratedUnitComponents([instance(1), instance(2)], m.store), applyCode('COMPONENT_APPLY_TARGET_REUSED'));
});

test('JSONB property order is irrelevant, arrays and source metadata remain exact', async () => {
  const expected = instance(1, { data: { a: 1, b: [2, 3] } });
  const m = memoryUnit();
  const insert = m.store.insert;
  m.store.insert = async c => { const id = await insert(c); m.rows[0].data = { b: [2, 3], a: 1 }; return id; };
  await applyGeneratedUnitComponents([expected], m.store);
});

test('same instance ID in another unit is not an update target', async () => {
  const unrelated = memoryUnit([stored(instance(1), 'other-unit-block')]);
  const selected = memoryUnit();
  await applyGeneratedUnitComponents([instance(1)], selected.store);
  assert.equal(unrelated.writes(), 0);
  assert.equal(unrelated.rows[0].id, 'other-unit-block');
  assert.equal(selected.rows.length, 1);
});

test('all identity conflicts are resolved before the first component write', async () => {
  const manual = instance(2, { metadata: { ...instance(2).metadata, generated_by: 'manual' } });
  const m = memoryUnit([stored(manual)]);
  await assert.rejects(applyGeneratedUnitComponents([instance(1), instance(2)], m.store), applyCode('COMPONENT_APPLY_PROTECTED_INSTANCE'));
  assert.equal(m.writes(), 0);
});

test('parity exception allows transaction owner to roll back the entire unit (mocked store)', async () => {
  const committed = [stored(instance(8), 'old-block')];
  const before = structuredClone(committed);
  let commits = 0;
  async function simulatedTransaction() {
    const transaction = memoryUnit(committed);
    const insert = transaction.store.insert;
    transaction.store.insert = async c => {
      const id = await insert(c);
      transaction.rows.find(r => r.id === id)!.data = 'wrong value';
      return id;
    };
    await applyGeneratedUnitComponents([instance(1)], transaction.store);
    commits++;
    committed.splice(0, committed.length, ...transaction.rows);
  }
  await assert.rejects(simulatedTransaction(), applyCode('COMPONENT_APPLY_PARITY_FAILED'));
  assert.equal(commits, 0);
  assert.deepEqual(committed, before);
});

test('production adapter retains tenant scope, lock, permissions and transaction rollback boundary', () => {
  const source = readFileSync(new URL('./course-authoring.service.ts', import.meta.url), 'utf8');
  const apply = source.slice(source.indexOf('export async function applyLessonAuthorProposalToCourse('), source.indexOf('export async function initializeCourseStructure('));
  assert.match(apply, /withDatabaseTransaction\(async \(client\)/);
  assert.match(apply, /pg_try_advisory_xact_lock/);
  assert.match(apply, /assertLessonAuthorProposalComponentsValid/);
  assert.match(apply, /assertLessonAuthorOperationTargetFreshWithClient/);
  assert.match(apply, /assertCourseComponentTypeAllowed/);
  assert.match(apply, /applyGeneratedUnitComponents[\s\S]*c\.tenant_id = \$3[\s\S]*FOR UPDATE OF cb/);
  assert.match(apply, /failure_stage: 'component_apply_identity_parity'/);
  assert.match(apply, /throw normalizedError/);
  assert.ok(apply.indexOf('applyGeneratedUnitComponents') < apply.indexOf("'transaction_prepared'"));
  const transaction = readFileSync(new URL('../../config/database.ts', import.meta.url), 'utf8');
  assert.match(transaction, /const result = await transactionClientStorage.run\(client, \(\) => work\(client\)\);[\s\S]*client.query\('COMMIT'\)/);
  assert.match(transaction, /catch \(error\)[\s\S]*client.query\('ROLLBACK'\)/);
});

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

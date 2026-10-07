import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layoutGeneratedDiagramNodes,
  normalizeDiagramDisplayText,
  validateGeneratedDiagramGeometry,
} from './lesson-author-diagram-layout.logic.js';

function nodes() {
  return [
    { id: 'root', position: { x: 0, y: 0 }, data: { label: 'Khung quản trị rủi ro' } },
    { id: 'identify', position: { x: 0, y: 0 }, data: { label: 'Nhận diện mối nguy tại nơi làm việc' } },
    { id: 'assess', position: { x: 0, y: 0 }, data: { label: 'Đánh giá khả năng và hậu quả' } },
    { id: 'control', position: { x: 0, y: 0 }, data: { label: 'Lựa chọn biện pháp kiểm soát phù hợp' } },
    { id: 'monitor', position: { x: 0, y: 0 }, data: { label: 'Theo dõi hiệu lực kiểm soát' } },
    { id: 'record', position: { x: 0, y: 0 }, data: { label: 'Ghi nhận kết quả đánh giá' } },
    { id: 'review', position: { x: 0, y: 0 }, data: { label: 'Rà soát khi điều kiện thay đổi' } },
    { id: 'improve', position: { x: 0, y: 0 }, data: { label: 'Cải tiến biện pháp kiểm soát' } },
  ];
}

const edges = [
  { source: 'root', target: 'identify' }, { source: 'root', target: 'assess' },
  { source: 'identify', target: 'control' }, { source: 'assess', target: 'control' },
  { source: 'control', target: 'monitor' }, { source: 'control', target: 'record' },
  { source: 'monitor', target: 'review' }, { source: 'record', target: 'review' },
  { source: 'review', target: 'improve' },
];

test('diagram display text removes escaped and control newline tokens', () => {
  assert.equal(normalizeDiagramDisplayText(String.raw`Mối nguy\nBiện pháp /n Kiểm soát\r\nXác nhận`),
    'Mối nguy Biện pháp Kiểm soát Xác nhận');
  assert.equal(normalizeDiagramDisplayText('Mối nguy\u000bKiểm soát'), 'Mối nguy Kiểm soát');
});

test('layered diagram layout is deterministic, readable and overlap-free', () => {
  const first = layoutGeneratedDiagramNodes(structuredClone(nodes()), edges);
  const second = layoutGeneratedDiagramNodes(structuredClone(nodes()), edges);
  assert.deepEqual(first.map(node => node.position), second.map(node => node.position));
  assert.equal(validateGeneratedDiagramGeometry(first), null);
  const byId = new Map(first.map(node => [node.id, node]));
  for (const edge of edges) {
    assert.ok(byId.get(edge.target)!.position.y > byId.get(edge.source)!.position.y,
      `${edge.source} must be above ${edge.target}`);
  }
});

test('layout remains finite for a cycle and validator rejects overlapping input', () => {
  const cycle = layoutGeneratedDiagramNodes(nodes().slice(0, 3), [
    { source: 'root', target: 'identify' },
    { source: 'identify', target: 'assess' },
    { source: 'assess', target: 'root' },
  ]);
  assert.equal(validateGeneratedDiagramGeometry(cycle), null);
  assert.ok(cycle.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y)));
  assert.match(validateGeneratedDiagramGeometry([
    { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
    { id: 'b', position: { x: 100, y: 10 }, data: { label: 'B' } },
  ]) ?? '', /overlap/);
});

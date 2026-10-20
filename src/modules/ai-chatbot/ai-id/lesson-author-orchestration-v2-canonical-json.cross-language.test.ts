import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AI_RAG_DEV_PYTHON, AI_RAG_ROOT, aiRagPythonSkip } from '../../../test-support/ai-rag-python.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import { canonicalJson } from './lesson-author-orchestration-v2-canonical-json.logic.js';
import { idmBriefHash, idmDesignHash } from './lesson-author-idm-primitives.contract.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { prepareOrchestrationV2UnitGenerationContract } from './lesson-author-orchestration-v2-unit.logic.js';

/**
 * Node's orchestrationV2Hash and Python's js_canonical_hash (app/hashing.py) on the same vectors, in both
 * wire directions: Node JSON → Python (unit contract, unit brief) and Python JSON → Node (design hash).
 * Python's own canonical_hash is shown to differ exactly where the JavaScript number and key layout does.
 */

const RAG_ROOT = AI_RAG_ROOT;
const LS = String.fromCodePoint(0x2028), PS = String.fromCodePoint(0x2029);
const TEXT = 'Thiết kế khóa học an toàn';

interface VectorResult {
  python: Record<string, { js: string; native: string; text: string; wire: string }>;
  from_node: Record<string, string>;
  random: string[];
}
interface ContractResult {
  contract_accepted: boolean;
  python_native_contract_hash: string;
  brief_hash: string;
  design: string;
  design_hash: string;
}

function python<T>(source: string, input: unknown): T {
  const out = spawnSync(AI_RAG_DEV_PYTHON, ['-X', 'utf8', '-B', '-c', source], {
    cwd: RAG_ROOT, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000, maxBuffer: 16_000_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(out.status, 0, out.error?.message ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}

// The same vectors written as JavaScript literals here and as Python literals in PYTHON_VECTORS.
const JS_VECTORS: Record<string, unknown> = {
  vietnamese_nfc: TEXT.normalize('NFC'),
  vietnamese_nfd: TEXT.normalize('NFD'),
  astral_keys: { z: 0, '😀': 1, 'ﬁ': 2, '𝒜': 3, 'đ': 4 },
  line_separators: `a${LS}b${PS}c`,
  null_value: { a: null },
  missing_value: {},
  max_safe_integer: 2 ** 53 - 1,
  half: 0.5,
  small: 5e-5,
  tiny: 1e-7,
  big: 1e16,
  huge: 1e21,
  negative_zero: -0,
  whole_float: 1,
  mixed: { bbox: [5e-5, 0, 1, 0.123456], title: TEXT.normalize('NFD'), note: null, list: [1e16, -0, 2 ** 53 - 1],
    '😀': [LS] },
};

const PYTHON_VECTORS = `
import unicodedata
LS, PS = chr(0x2028), chr(0x2029)
TEXT = "Thiết kế khóa học an toàn"
VECTORS = {
    "vietnamese_nfc": unicodedata.normalize("NFC", TEXT),
    "vietnamese_nfd": unicodedata.normalize("NFD", TEXT),
    "astral_keys": {"z": 0, "😀": 1, "ﬁ": 2, "𝒜": 3, "đ": 4},
    "line_separators": "a" + LS + "b" + PS + "c",
    "null_value": {"a": None},
    "missing_value": {},
    "max_safe_integer": 2**53 - 1,
    "half": 0.5,
    "small": 5e-05,
    "tiny": 1e-07,
    "big": 1e16,
    "huge": 1e21,
    "negative_zero": -0.0,
    "whole_float": 1.0,
    "mixed": {"bbox": [5e-05, 0.0, 1.0, 0.123456], "title": unicodedata.normalize("NFD", TEXT), "note": None,
              "list": [1e16, -0.0, 2**53 - 1], "😀": [LS]},
}
`;

const VECTOR_SOURCE = `
import json, sys
from app.hashing import canonical_hash, js_canonical_hash, js_canonical_json
${PYTHON_VECTORS}
request = json.loads(sys.stdin.read())
result = {
    "python": {name: {"js": js_canonical_hash(value), "native": canonical_hash(value), "text": js_canonical_json(value),
                      "wire": json.dumps(value, ensure_ascii=False)} for name, value in VECTORS.items()},
    "from_node": {name: js_canonical_hash(value) for name, value in request["vectors"].items()},
    "random": [js_canonical_hash(value) for value in request["random"]],
}
sys.stdout.write("\\n" + json.dumps(result))
`;

/** mulberry32 over JSON values with floats of every magnitude. */
function randomValues(seed: number, count: number): unknown[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const keys = ['a', 'z', 'đ', '😀', 'ﬁ', '10', '2', 'bbox', `k${LS}`];
  const value = (depth: number): unknown => {
    const roll = next();
    if (depth <= 0 || roll < 0.5) {
      const kind = next();
      if (kind < 0.1) return null;
      if (kind < 0.2) return kind < 0.15;
      if (kind < 0.7) return (next() - 0.5) * 10 ** Math.floor(next() * 50 - 25);
      if (kind < 0.8) return Math.round(next() * 1e6) / 1e6;
      return [TEXT.normalize('NFC'), TEXT.normalize('NFD'), `x${PS}`, '😀'][Math.floor(next() * 4)];
    }
    if (roll < 0.75) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) },
      () => [keys[Math.floor(next() * keys.length)]!, value(depth - 1)]));
  };
  return Array.from({ length: count }, () => value(4));
}

test('Node and Python hash the shared vectors identically, in both wire directions', { skip: aiRagPythonSkip }, () => {
  const random = randomValues(20261020, 300);
  const result = python<VectorResult>(VECTOR_SOURCE, { vectors: JS_VECTORS, random });
  for (const [name, value] of Object.entries(JS_VECTORS)) {
    const node = orchestrationV2Hash(value);
    const fromPython = result.python[name]!;
    assert.equal(fromPython.js, node, `${name}: Python literal`);
    assert.equal(fromPython.text, canonicalJson(value), `${name}: canonical text`);
    // Python → Node: a value Python returns over HTTP (json.dumps) and Node re-hashes.
    assert.equal(orchestrationV2Hash(JSON.parse(fromPython.wire)), fromPython.js, `${name}: Python JSON read by Node`);
    // Node → Python: a value Node sends and Python re-hashes.
    assert.equal(result.from_node[name], node, `${name}: Node JSON read by Python`);
  }
  assert.deepEqual(result.random, random.map(value => orchestrationV2Hash(value)));
  // No Unicode normalisation; null is not a missing key.
  assert.notEqual(orchestrationV2Hash(JS_VECTORS.vietnamese_nfc), orchestrationV2Hash(JS_VECTORS.vietnamese_nfd));
  assert.notEqual(orchestrationV2Hash(JS_VECTORS.null_value), orchestrationV2Hash(JS_VECTORS.missing_value));
  // Where Python's own encoding differs (and so where the cross-language hashes needed the Node encoding).
  const differs = Object.entries(result.python)
    .filter(([, hashes]) => hashes.js !== hashes.native).map(([name]) => name).sort();
  assert.deepEqual(differs, ['astral_keys', 'big', 'mixed', 'negative_zero', 'small', 'tiny', 'whole_float']);
});

const CONTRACT_SOURCE = `
import json, sys
from app.contracts.orchestration_v2.provider import UnitGenerationContractV2
from app.hashing import canonical_hash
from app.idm.contracts import brief_hash_of, design_hash_of
request = json.loads(sys.stdin.read())
contract = UnitGenerationContractV2.model_validate(request["contract"])
base = contract.model_dump(exclude={"contract_hash"})
base.pop("idm_unit_brief", None)
design = {"design_hash": "", "pipeline_version": "idm-1", "est_minutes": 1.0, "weight": 5e-05, "title": "Thiết kế"}
sys.stdout.write("\\n" + json.dumps({
    "contract_accepted": contract.contract_hash == request["contract"]["contract_hash"],
    "python_native_contract_hash": canonical_hash(base),
    "brief_hash": brief_hash_of(request["brief"]),
    "design": json.dumps(design),
    "design_hash": design_hash_of(design),
}))
`;

test('a unit contract with a 5e-05 locator coordinate, a brief and a design verify across the languages',
  { skip: aiRagPythonSkip }, () => {
    const source = orchestrationV2Hash('canonical-json-cross-language');
    const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
      title: 'An toàn', summary: 'Tóm tắt', target_audience: 'Tổ trưởng', prerequisites: [],
      learning_outcomes: ['Áp dụng'], assessment_strategy: 'Thực hành', assumptions: [], chapters: [{
        chapter_key: 'chapter-1', order: 0, title: 'Chương 1', objective: 'Hiểu', learning_outcomes: ['Áp dụng'],
        source_scope_ids: ['scope-1'] }] };
    const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
      shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chương 1', objective: 'Hiểu', lessons: [{
        title: 'Bài 1', objective: 'Hiểu', learning_objectives: ['Áp dụng'], learning_activities: ['Đọc'],
        assessment: 'Kiểm tra', units: [{ title: 'Đơn vị 1', purpose: 'Dạy', learning_objective_refs: ['lo_1'],
          source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const, title: 'Giải thích',
            rationale: 'Dạy', source_scope_ids: ['scope-1'] }], media_brief: null }] }] };
    const assembly = assembleOrchestrationV2Architecture(skeleton,
      [{ scope_key: 'scope-1', title: 'Phạm vi', source_ref: 'a.pdf', fact_count: 1, content_chars: 30 }],
      [{ artifact_hash: orchestrationV2Hash('shard'), shard }]);
    const contract = prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: 'chapter_1.lesson_1.unit_1',
      source_facts: [{ document_id: '00000000-0000-4000-8000-000000000011', fact_key: 'fact-1', scope_key: 'scope-1',
        fact_text: 'Nhận diện mối nguy trước khi làm.', source_ref: 'a.pdf', source_page: 1, source_chunk: 0,
        locator: { visual_regions: [{ bbox: [5e-5, 0, 1, 0.5], confidence: 1 }] } }] });
    const brief = { brief_hash: '', share: 0.5, small: 5e-5, whole: 1, title: TEXT.normalize('NFD') };
    const result = python<ContractResult>(CONTRACT_SOURCE, { contract: JSON.parse(JSON.stringify(contract)), brief });
    // Python accepts the Node contract hash; its own encoding would not have (it writes 5e-05 and 1.0 / 0.0).
    assert.equal(result.contract_accepted, true);
    assert.notEqual(result.python_native_contract_hash, contract.contract_hash);
    assert.equal(result.brief_hash, idmBriefHash(brief));
    // The design Python hashes and returns as JSON is re-hashed by Node's design check.
    assert.equal(idmDesignHash(JSON.parse(result.design) as object), result.design_hash);
  });

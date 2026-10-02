import { z } from 'zod';

/** Narrow codec for the five XML shapes emitted by Lesson Author, NOT a
 * permissive Open edX XML parser. Unsupported legacy XML remains read-only. */
const xmlText = (v: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v);
const text = z.string().min(1).max(4000).refine(v => !!v.trim() && xmlText(v));
const hint = z.string().max(4000).refine(xmlText);
const common = {
  question: text,
  explanation: z.string().max(8000).refine(xmlText),
  // Older workspace revisions predate author-editable hints. Defaulting the
  // missing field keeps those revisions readable while every newly encoded
  // revision receives one canonical shape.
  hints: z.array(hint).max(10).default([]),
};
export const workspaceProblemSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('multiple_choice'), choices: z.array(z.object({ text, correct: z.boolean() }).strict()).min(2).max(8) }).strict(),
  z.object({ ...common, kind: z.literal('multiple_select'), choices: z.array(z.object({ text, correct: z.boolean() }).strict()).min(2).max(8) }).strict(),
  z.object({ ...common, kind: z.literal('dropdown'), choices: z.array(z.object({ text, correct: z.boolean() }).strict()).min(2).max(8) }).strict(),
  z.object({ ...common, kind: z.literal('short_text'), answers: z.array(text).min(1).max(5), case_sensitive: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal('numerical'), answers: z.array(text).min(1).max(5), tolerance: z.string().max(40) }).strict(),
]);
export type WorkspaceProblem = z.infer<typeof workspaceProblemSchema>;
export class WorkspaceProblemError extends Error {
  constructor(readonly code: 'WORKSPACE_PROBLEM_UNSUPPORTED' | 'WORKSPACE_PROBLEM_INVALID') { super(code); }
}
function fail(): never { throw new WorkspaceProblemError('WORKSPACE_PROBLEM_UNSUPPORTED'); }
function invalid(): never { throw new WorkspaceProblemError('WORKSPACE_PROBLEM_INVALID'); }
function escape(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function decode(value: string): string {
  // Existing generated XML uses these five entities. Do not resolve DTDs,
  // external entities, markup, numeric entities or arbitrary embedded HTML.
  if (/[<>]/.test(value) || /&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) fail();
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_all, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]!);
}
export function readWorkspaceProblem(value: unknown): WorkspaceProblem {
  const result = workspaceProblemSchema.safeParse(value);
  if (!result.success) invalid();
  const p = result.data;
  if ('choices' in p) {
    const labels = p.choices.map(c => c.text.normalize('NFKC').toLocaleLowerCase());
    const correct = p.choices.filter(c => c.correct).length;
    if (new Set(labels).size !== labels.length || !correct || (p.kind !== 'multiple_select' && correct !== 1)) invalid();
  } else {
    if (new Set(p.answers).size !== p.answers.length) invalid();
    if (p.kind === 'numerical') {
      const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
      if (p.answers.some(a => !number.test(a) || !Number.isFinite(Number(a)))
        || !/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(p.tolerance)) invalid();
    }
  }
  return p;
}
export function decodeWorkspaceProblem(xml: unknown): WorkspaceProblem {
  if (typeof xml !== 'string' || xml.length > 100_000) fail();
  const outer = /^\s*<problem>\s*([\s\S]*?)\s*<\/problem>\s*$/.exec(xml);
  if (!outer) fail();
  let body = outer[1], explanation = '';
  const hints: string[] = [];
  const demandHint = /\s*<demandhint>\s*([\s\S]*?)\s*<\/demandhint>\s*$/.exec(body);
  if (demandHint) {
    const remaining = demandHint[1].replace(/<hint>([^<]*)<\/hint>/g, (_all, value: string) => {
      hints.push(decode(value));
      return '';
    });
    if (remaining.trim()) fail();
    body = body.slice(0, demandHint.index);
  }
  const solution = /\s*<solution><div class="detailed-solution"><p>([^<]*)<\/p><\/div><\/solution>\s*$/.exec(body);
  if (solution) { explanation = decode(solution[1]); body = body.slice(0, solution.index); }
  for (const [kind, response, group, item] of [
    ['multiple_choice', 'multiplechoiceresponse', 'choicegroup', 'choice'],
    ['multiple_select', 'choiceresponse', 'checkboxgroup', 'choice'],
    ['dropdown', 'optionresponse', 'optioninput', 'option'],
  ] as const) {
    const groupAttrs = kind === 'multiple_choice' ? '(?: type="MultipleChoice")?' : '';
    const match = new RegExp(`^\\s*<${response}>\\s*<label>([^<]*)<\\/label>\\s*<${group}${groupAttrs}>([\\s\\S]*?)<\\/${group}>\\s*<\\/${response}>\\s*$`).exec(body);
    if (!match) continue;
    const choices: Array<{ text: string; correct: boolean }> = [];
    const remaining = match[2].replace(new RegExp(`<${item} correct="(true|false)">([^<]*)<\\/${item}>`, 'g'), (_all, correct: string, label: string) => {
      choices.push({ text: decode(label), correct: correct === 'true' }); return '';
    });
    if (remaining.trim()) fail();
    return readWorkspaceProblem({ kind, question: decode(match[1]), explanation, hints, choices });
  }
  for (const kind of ['short_text', 'numerical'] as const) {
    const response = kind === 'short_text' ? 'stringresponse' : 'numericalresponse';
    const attrs = kind === 'short_text' ? ' type="(cs|ci)"' : '';
    const match = new RegExp(`^\\s*<${response} answer="([^"]*)"${attrs}>\\s*<label>([^<]*)<\\/label>([\\s\\S]*?)<\\/${response}>\\s*$`).exec(body);
    if (!match) continue;
    const question = decode(match[kind === 'short_text' ? 3 : 2]);
    let rest = match[kind === 'short_text' ? 4 : 3];
    const answers = [decode(match[1])];
    rest = rest.replace(/<additional_answer answer="([^"]*)"\s*\/>/g, (_all, answer: string) => { answers.push(decode(answer)); return ''; });
    if (kind === 'short_text') {
      if (!/^\s*<textline size="30"\s*\/>\s*$/.test(rest)) fail();
      return readWorkspaceProblem({ kind, question, explanation, hints, answers, case_sensitive: match[2] === 'cs' });
    }
    const tail = /^\s*(?:<responseparam type="tolerance" default="([^"]*)"\s*\/>\s*)?<formulaequationinput\s*\/>\s*$/.exec(rest);
    if (!tail) fail();
    return readWorkspaceProblem({ kind, question, explanation, hints, answers, tolerance: decode(tail[1] ?? '0') });
  }
  return fail();
}
export function encodeWorkspaceProblem(input: unknown): string {
  const p = readWorkspaceProblem(input);
  const label = `<label>${escape(p.question)}</label>`;
  let response: string;
  if ('choices' in p) {
    const [tag, group, item] = p.kind === 'multiple_choice' ? ['multiplechoiceresponse', 'choicegroup', 'choice']
      : p.kind === 'multiple_select' ? ['choiceresponse', 'checkboxgroup', 'choice'] : ['optionresponse', 'optioninput', 'option'];
    response = `<${tag}>${label}<${group}${p.kind === 'multiple_choice' ? ' type="MultipleChoice"' : ''}>`
      + p.choices.map(c => `<${item} correct="${c.correct}">${escape(c.text)}</${item}>`).join('') + `</${group}></${tag}>`;
  } else {
    const extra = p.answers.slice(1).map(a => `<additional_answer answer="${escape(a)}" />`).join('');
    response = p.kind === 'short_text'
      ? `<stringresponse answer="${escape(p.answers[0])}" type="${p.case_sensitive ? 'cs' : 'ci'}">${label}${extra}<textline size="30" /></stringresponse>`
      : `<numericalresponse answer="${escape(p.answers[0])}">${label}${extra}<responseparam type="tolerance" default="${escape(p.tolerance)}" /><formulaequationinput /></numericalresponse>`;
  }
  const hints = p.hints.filter(value => value.trim()).map(value => `<hint>${escape(value)}</hint>`).join('');
  return `<problem>${response}${p.explanation ? `<solution><div class="detailed-solution"><p>${escape(p.explanation)}</p></div></solution>` : ''}${hints ? `<demandhint>${hints}</demandhint>` : ''}</problem>`;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { containsActiveMarkup, scrubActiveMarkup, scrubMarkupDeep } from './course-markup-scrubber.logic.js';
import { sanitizeCourseRichText } from './course-html-sanitizer.logic.js';

// S1 C5: stored component markup can no longer carry executable content,
// and valid OLX / course rich text is not corrupted.

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  "<img src='x' onerror='alert(1)'>",
  '<img/onerror=alert(1) src=x>',
  '<svg onload=alert(1)>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.test"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<details open ontoggle=alert(1)>x</details>',
  '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">b</button></form>',
  '<p style="background:url(javascript:alert(1))">x</p>',
];

function assertInert(html: string, label: string): void {
  assert.doesNotMatch(html, /[\s"'/]on[a-z]+\s*=/i, `${label} -> ${html}`);
  assert.doesNotMatch(html, /javascript\s*:|&#106;avascript|java&#x09;script|data:text\/html/i, `${label} -> ${html}`);
  assert.doesNotMatch(html, /<\s*(?:script|iframe|object|embed)\b/i, `${label} -> ${html}`);
}

test('every payload is detected and scrubbed, in HTML and in OLX (XML) mode', () => {
  for (const payload of PAYLOADS) {
    assert.equal(containsActiveMarkup(payload), true, payload);
    assertInert(scrubActiveMarkup(payload), payload);
    assertInert(scrubActiveMarkup(`<problem><p>Q</p>${payload}</problem>`, { xml: true }), `xml ${payload}`);
  }
});

test('valid OLX without active markup is returned byte-for-byte', () => {
  const olx = [
    '<problem display_name="Câu 1" markdown="null"><p>Chọn đáp án &amp; giải thích&nbsp;ngắn</p>',
    '<multiplechoiceresponse><label>Thủ đô?</label><choicegroup type="MultipleChoice">',
    '<choice correct="true">Hà Nội <choicehint>Đúng</choicehint></choice><choice correct="false">A &lt; B</choice>',
    '</choicegroup></multiplechoiceresponse><optionresponse><optioninput options="(\'a\',\'b\')" correct="a"/></optionresponse>',
    '<br/><img src="/api/storage/11111111-1111-4111-8111-111111111111/courses/c/a.png" alt="hình"/>',
    '<!-- ghi chú --><![CDATA[ x < y ]]><script type="loncapa/python">answer = 1</script>',
    '<solution><div class="detailed-solution"><p>Online learning: on time</p></div></solution></problem>',
  ].join('');
  assert.equal(containsActiveMarkup(olx), false);
  assert.equal(scrubActiveMarkup(olx, { xml: true }), olx);
  assert.equal(scrubMarkupDeep(olx, { xml: true }), olx);
});

test('OLX with a handler keeps its problem structure and inert grading scripts', () => {
  const olx = '<problem><p onclick=alert(1)>Q</p><choicegroup type="MultipleChoice"><choice correct="true">A</choice><choice correct="false">B</choice></choicegroup><script type="loncapa/python">x = 1</script><script>alert(2)</script></problem>';
  const out = scrubActiveMarkup(olx, { xml: true });
  assertInert(out.replace(/<script type="loncapa\/python">x = 1<\/script>/, ''), 'olx');
  assert.match(out, /<choicegroup type="MultipleChoice"><choice correct="true">A<\/choice><choice correct="false">B<\/choice><\/choicegroup>/);
  assert.match(out, /<script type="loncapa\/python">x = 1<\/script>/);
  assert.match(out, /<p>Q<\/p>/);
});

test('component JSON is scrubbed deeply, including JSON stored as a string; clean data keeps its identity', () => {
  const clean = { faq_data: '[{"q":"A?","a":"<p>Đúng</p>"}]', items: [{ text: '<b>x</b>' }], n: 3 };
  assert.equal(scrubMarkupDeep(clean), clean);

  const dirty = {
    crossword_data: JSON.stringify({ words: [{ clue: '<img src=x onerror=alert(1)>Gợi ý', answer: 'HANOI' }] }),
    question_text: '<a href="javascript:alert(1)">Câu hỏi</a>',
    nested: [{ html: '<svg onload=alert(1)>' }],
    url: 'https://example.test/file.pdf',
  };
  const out = scrubMarkupDeep(dirty);
  const words = JSON.parse(out.crossword_data).words;
  assert.equal(words[0].answer, 'HANOI');
  assert.match(words[0].clue, /Gợi ý/);
  assertInert(words[0].clue, 'clue');
  assertInert(out.question_text, 'question');
  assertInert(out.nested[0].html, 'nested');
  assert.equal(out.url, dirty.url);
});

test('quiz rich text uses the course allowlist: payloads removed, formatting kept, cuts stay well-formed', () => {
  for (const payload of PAYLOADS) assertInert(sanitizeCourseRichText(payload, '', 2000), payload);
  const kept = sanitizeCourseRichText('<p><strong>Đậm</strong> <em>nghiêng</em></p><ul><li>một</li></ul><img src="/api/storage/t/courses/c/a.png" alt="a">', '', 2000);
  assert.match(kept, /<p><strong>Đậm<\/strong> <em>nghiêng<\/em><\/p><ul><li>một<\/li><\/ul><img src="\/api\/storage\/t\/courses\/c\/a.png" alt="a" \/>/);
  assert.equal(sanitizeCourseRichText(undefined, 'Lựa chọn 1', 2000), 'Lựa chọn 1');
  const cut = sanitizeCourseRichText(`<p><strong>${'x'.repeat(50)}</strong></p>`, '', 20);
  assert.ok(cut.length <= 40);
  assert.match(cut, /^<p><strong>x+<\/strong><\/p>$/);
});

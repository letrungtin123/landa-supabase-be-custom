import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeCourseHtmlData, sanitizeCourseRichText } from './course-html-sanitizer.logic.js';
import { scrubActiveMarkup } from './course-markup-scrubber.logic.js';

// Exact output of the course rich-text allowlist (text blocks, quiz rich text)
// and of the active-markup scrubber (component payloads, problem OLX) for
// typical lesson HTML and for known attacks. Written against sanitize-html
// 2.17.0 and kept byte-for-byte across sanitize-html updates; a changed line
// documents why the new output is the safe one.

const course: Array<[name: string, input: string, output: string]> = [
  [
    'inline formatting, entities and line breaks',
    '<p>Xin chào <strong>học viên</strong>, <b>đậm</b> <em>chúc</em> <i>nghiêng</i> <u>bạn</u> <s>học</s> <strike>gạch</strike> tốt &amp; vui&nbsp;vẻ.<br>Dòng 2</p>',
    '<p>Xin chào <strong>học viên</strong>, <b>đậm</b> <em>chúc</em> <i>nghiêng</i> <u>bạn</u> <s>học</s> <strike>gạch</strike> tốt &amp; vui vẻ.<br />Dòng 2</p>',
  ],
  [
    'headings, lists, quotes and code',
    '<h1>T1</h1><h2>Mục tiêu</h2><h3>a</h3><h4>b</h4><h5>c</h5><h6>d</h6><header>hd</header><section><ul><li>Một</li><li>Hai</li></ul><ol><li>Ba</li></ol></section><blockquote>Trích dẫn</blockquote><pre><code>const a = 1 &lt; 2;</code></pre><hr><div>khối</div>',
    '<h1>T1</h1><h2>Mục tiêu</h2><h3>a</h3><h4>b</h4><h5>c</h5><h6>d</h6><header>hd</header><section><ul><li>Một</li><li>Hai</li></ul><ol><li>Ba</li></ol></section><blockquote>Trích dẫn</blockquote><pre><code>const a = 1 &lt; 2;</code></pre><hr /><div>khối</div>',
  ],
  [
    'links: http(s), mailto, tel, relative and anchors are kept; ftp loses its href',
    '<p><a href="https://landa.vn/khoa-hoc?id=1&amp;tab=2" target="_blank" rel="noopener" title="Khóa">Khóa học</a> <a href="http://landa.vn">http</a> <a href="mailto:hotro@landa.vn">Email</a> <a href="tel:+84901234567">Gọi</a> <a href="/api/storage/t/x.pdf">Tài liệu</a> <a href="#muc-1">Mục 1</a> <a href="khoa-hoc/2">rel</a> <a href="ftp://files.landa.vn/a">ftp</a></p>',
    '<p><a href="https://landa.vn/khoa-hoc?id=1&amp;tab=2" target="_blank" rel="noopener" title="Khóa">Khóa học</a> <a href="http://landa.vn">http</a> <a href="mailto:hotro@landa.vn">Email</a> <a href="tel:+84901234567">Gọi</a> <a href="/api/storage/t/x.pdf">Tài liệu</a> <a href="#muc-1">Mục 1</a> <a href="khoa-hoc/2">rel</a> <a>ftp</a></p>',
  ],
  [
    'script, data, protocol-relative and obfuscated links lose their href',
    '<p><a href="javascript:alert(1)">x</a><a href="JaVaScRiPt:alert(1)">y</a><a href="java&#x09;script:alert(1)">z</a><a href=" javascript:alert(1)">s</a><a href="//evil.example/x">p</a><a href="\\\\evil.example/x">b</a><a href="data:text/html;base64,PHNjcmlwdD4=">d</a><a href="vbscript:msgbox(1)">v</a><a href="jav&#97;script:alert(1)">e</a><a href="javascript&colon;alert(1)">c</a></p>',
    '<p><a>x</a><a>y</a><a>z</a><a>s</a><a>p</a><a>b</a><a>d</a><a>v</a><a>e</a><a>c</a></p>',
  ],
  [
    'images: http(s) and relative sources; data, script and protocol-relative sources and handlers removed',
    '<p><img src="https://cdn.landa.vn/a.png" alt="Ảnh" width="320" height="200" data-landa-image-mode="inline"><img src="/api/storage/tenant/courses/a.png" alt="rel"><img src="data:image/png;base64,iVBORw0KGgo=" alt="data"><img src="javascript:alert(1)" alt="js"><img src="x.png" onerror="alert(1)" alt="ev"><img src="//cdn.example/x.png" alt="pr"><img srcset="https://cdn/a.png 1x" src="https://cdn/b.png" alt="ss"></p>',
    '<p><img src="https://cdn.landa.vn/a.png" alt="Ảnh" width="320" height="200" data-landa-image-mode="inline" /><img src="/api/storage/tenant/courses/a.png" alt="rel" /><img alt="data" /><img alt="js" /><img src="x.png" alt="ev" /><img alt="pr" /><img src="https://cdn/b.png" alt="ss" /></p>',
  ],
  [
    'figure with caption',
    '<figure class="image"><img src="https://cdn.landa.vn/b.jpg" alt="b"><figcaption>Chú thích</figcaption></figure>',
    '<figure class="image"><img src="https://cdn.landa.vn/b.jpg" alt="b" /><figcaption>Chú thích</figcaption></figure>',
  ],
  [
    // sanitize-html >= 2.17.6 writes <col> as the void element it is (`<col ... />`);
    // 2.17.0 wrote `<col ...></col>`. Browsers ignore that end tag, so tables render the same.
    'tables keep their allowlisted inline styles and data attributes only',
    '<table class="landa-table" style="width:600px;min-width:300px;border:1px solid red"><colgroup><col width="120" style="width:120px"><col style="width:200px"></colgroup><thead><tr><th>h</th></tr></thead><tbody><tr class="r" style="height:48px" data-landa-row-height="48"><th style="background-color:#ff0000;color:red" align="left" colspan="2" data-landa-cell-bg="#ff0000">H</th></tr><tr><td style="background-color:#00ff00" rowspan="1" colwidth="120">A</td><td style="background-color:red">B</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
    '<table class="landa-table" style="width:600px;min-width:300px"><colgroup><col width="120" style="width:120px" /><col style="width:200px" /></colgroup><thead><tr><th>h</th></tr></thead><tbody><tr class="r" style="height:48px" data-landa-row-height="48"><th style="background-color:#ff0000" align="left" colspan="2" data-landa-cell-bg="#ff0000">H</th></tr><tr><td style="background-color:#00ff00" rowspan="1" colwidth="120">A</td><td>B</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
  ],
  [
    'a <col> stored by the editor with an end tag is written as a void element',
    '<table><colgroup><col style="width:120px"></col><col width="80" /></colgroup><tbody><tr><td>x</td></tr></tbody></table>',
    '<table><colgroup><col style="width:120px" /><col width="80" /></colgroup><tbody><tr><td>x</td></tr></tbody></table>',
  ],
  [
    'span colors: only #rrggbb survives; paragraph styles are dropped',
    '<p style="text-align:center"><span style="color:#336699;font-size:20px">Màu</span><span style="color:red">tên</span><span style="color:#ABCDEF">hex</span><span class="mention" style="">m</span></p>',
    '<p><span style="color:#336699">Màu</span><span>tên</span><span style="color:#ABCDEF">hex</span><span class="mention">m</span></p>',
  ],
  [
    'iframes, video, audio, embed and object are not allowed (their text stays)',
    '<p>trước</p><iframe src="https://www.youtube.com/embed/abc" width="560" height="315" allowfullscreen></iframe><video src="https://cdn/x.mp4" controls poster="https://cdn/p.jpg">v</video><embed src="x.swf"><object data="x">o</object><audio src="a.mp3">au</audio><p>sau</p>',
    '<p>trước</p>voau<p>sau</p>',
  ],
  [
    'scripts, styles and event handlers are removed; class names are filtered',
    '<script>alert(1)</script><style>p{color:red}</style><p onclick="alert(1)" class="ok bad!class">t</p><div class="a_b-1 ql-align-center">d</div><noscript>n</noscript>',
    '<p class="ok">t</p><div class="a_b-1 ql-align-center">d</div>n',
  ],
  [
    'entities, quotes and emoji',
    '<p>5 &lt; 6 &gt; 4 &quot;quote&quot; &#39;apos&#39; &copy; &hellip; © &#x1F600; &amp;amp; a&b <3</p>',
    '<p>5 &lt; 6 &gt; 4 "quote" \'apos\' © … © 😀 &amp;amp; a&amp;b &lt;3</p>',
  ],
  [
    'unclosed tags are closed',
    '<p><strong>đậm <em>lồng</p><ul><li>một<li>hai</ul>',
    '<p><strong>đậm <em>lồng</em></strong></p><ul><li>một</li><li>hai</li></ul>',
  ],
];

for (const [name, input, output] of course) {
  test(`course HTML: ${name}`, () => {
    assert.equal(sanitizeCourseHtmlData(input), output);
  });
}

test('course HTML: a textarea, SVG animation or xmp cannot smuggle markup through the allowlist', () => {
  const output = sanitizeCourseHtmlData(
    '<textarea></textarea/><img src=x onerror=alert(1)></textarea><svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg><xmp><img src=x onerror=alert(1)></xmp><p>end</p>',
  );
  assert.doesNotMatch(output, /onerror|javascript:|<svg|<animate|<textarea|<xmp/i);
  assert.match(output, /<p>end<\/p>$/);
});

test('quiz rich text: cut to the limit without a broken tag, unsafe parts removed', () => {
  assert.equal(
    sanitizeCourseRichText('<p><strong>Câu hỏi</strong> có <a href="https://landa.vn">liên kết</a> dài dòng</p>', '', 40),
    '<p><strong>Câu hỏi</strong> có </p>',
  );
  assert.equal(sanitizeCourseRichText(42, '<em>mặc định</em>', 100), '<em>mặc định</em>');
  assert.equal(
    sanitizeCourseRichText('<p onclick="x">Đáp án <img src="javascript:x" alt="a"> <a href="javascript:x">b</a></p>', '', 1000),
    '<p>Đáp án <img alt="a" /> <a>b</a></p>',
  );
});

const scrubbed: Array<[name: string, input: string, xml: boolean, output: string]> = [
  [
    'problem OLX keeps its vocabulary and inert grading script; handlers go',
    '<problem><script type="loncapa/python">x = 1 &lt; 2\nif x: pass</script><p onclick="x()">Q</p><customresponse cfn="check"><textline size="20"/></customresponse><solution><div class="detailed-solution"><p>Giải thích &amp; ví dụ</p></div></solution></problem>',
    true,
    '<problem><script type="loncapa/python">x = 1 &lt; 2\nif x: pass</script><p>Q</p><customresponse cfn="check"><textline size="20"></textline></customresponse><solution><div class="detailed-solution"><p>Giải thích &amp; ví dụ</p></div></solution></problem>',
  ],
  [
    'component HTML loses frames, script links and data: images',
    '<div><iframe src="https://evil"></iframe><a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA" alt="ok"><img src="data:image/svg+xml;base64,AAAA" alt="svg"><a href="https://ok.example">ok</a><a href="/relative">rel</a><span style="color:red" onmouseover="x">s</span></div>',
    false,
    '<div><a>x</a><img alt="ok" /><img alt="svg" /><a href="https://ok.example">ok</a><a href="/relative">rel</a><span style="color:red">s</span></div>',
  ],
];

for (const [name, input, xml, output] of scrubbed) {
  test(`component markup: ${name}`, () => {
    assert.equal(scrubActiveMarkup(input, { xml }), output);
  });
}

test('component markup: markup without active content is returned unchanged', () => {
  const olx = '<problem><multiplechoiceresponse><choicegroup type="MultipleChoice"><choice correct="true">A &amp; B</choice><choice correct="false">C</choice></choicegroup></multiplechoiceresponse></problem>';
  assert.equal(scrubActiveMarkup(olx, { xml: true }), olx);
});

test('component markup: URL attributes keep http(s) and relative values, never script URLs', () => {
  const output = scrubActiveMarkup(
    '<div onclick="x"><form action="javascript:alert(1)"><button formaction="https://ok.example/submit">b</button></form><video poster="javascript:alert(1)" src="https://x/v.mp4"></video><video poster="/p.jpg" src="/v.mp4"></video><table><tr><td background="javascript:x">t</td><td background="bg.png">u</td></tr></table><img usemap="#m" src="a.png"></div>',
  );
  assert.equal(
    output,
    '<div><form><button formaction="https://ok.example/submit">b</button></form><video src="https://x/v.mp4"></video><video poster="/p.jpg" src="/v.mp4"></video><table><tr><td>t</td><td background="bg.png">u</td></tr></table><img usemap="#m" src="a.png" /></div>',
  );
});

test('component markup: data, itemid and the other URL attributes lose a non-web scheme (sanitize-html >= 2.17.5)', () => {
  assert.equal(
    scrubActiveMarkup('<div onclick="x"><div itemid="urn:isbn:123">i</div><x-widget data="config:value">w</x-widget><a ping="https://track.example">p</a><blob-link href="blob:https://x/1">b</blob-link></div>'),
    '<div><div>i</div><x-widget>w</x-widget><a ping="https://track.example">p</a><blob-link>b</blob-link></div>',
  );
});

test('component markup: xmp content is escaped, not re-emitted as markup (sanitize-html >= 2.17.6)', () => {
  assert.equal(scrubActiveMarkup('<div onclick="x"><xmp><b>raw</b> &amp;</xmp></div>'), '<div><xmp>&lt;b&gt;raw&lt;/b&gt; &amp;</xmp></div>');
});

test('component markup: SVG animations cannot retarget a link to a script URL', () => {
  const output = scrubActiveMarkup(
    '<svg onload="x"><a href="#"><animate attributeName="href" values="#safe;javascript:alert(1)"/><set attributeName="xlink:href" to="javascript:alert(1)"/><animate attributeName="opacity" values="0;1" dur="1s"/><text>t</text></a><use xlink:href="#icon"/></svg>',
  );
  assert.doesNotMatch(output, /javascript:|onload/i);
  assert.match(output, /<animate attributename="opacity" values="0;1" dur="1s"><\/animate>/);
  assert.match(output, /<use xlink:href="#icon"><\/use>/);
});

test('component markup: textarea content cannot reopen a tag', () => {
  const output = scrubActiveMarkup('<div onclick="x"><textarea></textarea/><img src=x onerror=alert(1)></textarea><textarea>a &lt; b &amp; c</textarea></div>');
  assert.doesNotMatch(output, /onerror|onclick/i);
  assert.match(output, /<textarea>a &lt; b &amp; c<\/textarea><\/div>$/);
});

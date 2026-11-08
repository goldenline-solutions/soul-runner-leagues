import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDiscord, inline } from '../public/js/discord-md.js';

test('Discord markdown: headings, lists, quotes and inline formatting', () => {
  const { html, headings } = renderDiscord([
    '# League Rules',
    '**Be respectful.** No *toxicity* and __no__ ~~cheating~~.',
    'Second line of the same paragraph.',
    '',
    '## Games',
    '- Best of 3',
    '  - Game 3 only if needed',
    '- Report scores in <#123456>',
    '',
    '3. Third rule',
    '4. Fourth rule',
    '> Commissioner decisions are final',
    '-# small print',
    'See [the site](https://example.com/rules?a=1&b=2) or https://example.com.',
  ].join('\r\n'));
  assert.deepEqual(headings.map(h => [h.level, h.id]), [[1, 'rule-league-rules'], [2, 'rule-games']]);
  assert.match(html, /<h3 id="rule-league-rules">League Rules<\/h3>/);
  assert.match(html, /<p><strong>Be respectful\.<\/strong> No <em>toxicity<\/em> and <u>no<\/u> <s>cheating<\/s>\.<br>Second line/);
  assert.match(html, /<ul><li>Best of 3<ul><li>Game 3 only if needed<\/li><\/ul><\/li><li>Report scores in #channel<\/li><\/ul>/);
  assert.match(html, /<ol start="3"><li>Third rule<\/li><li>Fourth rule<\/li><\/ol>/);
  assert.match(html, /<blockquote>Commissioner decisions are final<\/blockquote>/);
  assert.match(html, /<p class="subtext">small print<\/p>/);
  assert.match(html, /<a href="https:\/\/example\.com\/rules\?a=1&amp;b=2" [^>]*>the site<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com" [^>]*>https:\/\/example\.com<\/a>\.<\/p>/);
});

test('Discord markdown: everything else is escaped', () => {
  const { html } = renderDiscord('<script>alert(1)</script>\n```\n<b>raw</b> **not bold**\n```\n[x](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|<b>|javascript:alert\(1\)"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt; \*\*not bold\*\*<\/code><\/pre>/);
  assert.equal(inline('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(inline('`**code**`'), '<code>**code**</code>');
});

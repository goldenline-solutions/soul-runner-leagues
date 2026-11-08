// Renders text pasted from Discord (Discord's markdown) as safe HTML for the League Rules page.
// Everything is escaped first; only the formatting below is turned into tags.
//   # / ## / ### headings, -# small text, - or * bullets (indent for sub-points), 1. numbered lists,
//   > quotes, >>> quote-to-end, ``` code blocks, **bold**, *italic* / _italic_, __underline__,
//   ~~strike~~, `code`, ||spoiler||, [text](https://link) and bare https:// links.
// Discord-only tokens are made readable: <#123> -> #channel, <@&123> -> @role, <:name:123> -> :name:.
// Pure module (no DOM) so it can be tested in Node.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function discordTokens(s) {
  return s
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?\d+>/g, '@member')
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, sec) => new Date(Number(sec) * 1000).toLocaleString());
}

export function inline(raw) {
  const keep = [];
  const hold = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = discordTokens(raw);
  // Code spans and links are set aside first so their contents aren't formatted.
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(label)}</a>`));
  s = s.replace(/<?(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])>?/g, (_, url) =>
    hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
  s = esc(s);
  s = s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

// Returns { html, headings: [{ level, id, text }] }.
export function renderDiscord(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const ids = new Set();
  let para = [];
  let list = null; // { type: 'ul' | 'ol', items: [{ html, sub: [] }] }
  let quote = [];
  let quoteRest = false;

  const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(it => `<li>${it.html}${it.sub.length ? `<ul>${it.sub.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}</li>`).join('');
    const start = list.type === 'ol' && list.items[0].n > 1 ? ` start="${list.items[0].n}"` : '';
    out.push(`<${list.type}${start}>${items}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); quote = []; };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { // code block until the closing fence
      flushAll();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (quoteRest) { quote.push(inline(line)); continue; }
    if (!line.trim()) { flushAll(); continue; }

    let m;
    if ((m = line.match(/^>>>\s?(.*)$/))) { flushPara(); flushList(); quoteRest = true; quote.push(inline(m[1])); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(inline(m[1])); continue; }
    flushQuote();
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara(); flushList();
      const level = m[1].length;
      const html = inline(m[2].trim());
      let id = `rule-${slug(html) || 'section'}`;
      for (let n = 2; ids.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
      ids.add(id);
      headings.push({ level, id, html });
      out.push(`<h${level + 2} id="${id}">${html}</h${level + 2}>`);
      continue;
    }
    if ((m = line.match(/^-#\s+(.+)$/))) { flushPara(); flushList(); out.push(`<p class="subtext">${inline(m[1])}</p>`); continue; }
    if ((m = line.match(/^(\s*)[-*•]\s+(.+)$/))) {
      flushPara();
      const nested = m[1].replace(/\t/g, '  ').length >= 2;
      if (nested && list?.items.length) { list.items.at(-1).sub.push(inline(m[2])); continue; }
      if (list?.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push({ html: inline(m[2]), sub: [] });
      continue;
    }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/))) {
      flushPara();
      const nested = m[1].replace(/\t/g, '  ').length >= 2;
      if (nested && list?.items.length) { list.items.at(-1).sub.push(inline(m[3])); continue; }
      if (list?.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push({ html: inline(m[3]), sub: [], n: Number(m[2]) });
      continue;
    }
    flushList();
    para.push(inline(line));
  }
  flushAll();
  return { html: out.join('\n'), headings };
}

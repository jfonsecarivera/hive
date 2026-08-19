// A small, safe markdown renderer for assistant text. Everything is HTML-escaped
// FIRST; the only tags in the output are the ones this file emits, so agent output
// can never inject markup. Covers what agents actually write: fenced code, inline
// code, headings, lists, quotes, bold/italic, links, hr, tables-as-code (left as-is).

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let out = esc(s);
  // code spans first — their content is opaque to every other rule
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // [text](url) then bare urls; only http(s) — never javascript:
  out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = (src || "").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`); para = []; }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const lang = esc(fence[1].trim().split(/\s+/)[0] || "");
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;                                   // past the closing fence (or EOF)
      out.push(`<pre data-lang="${lang}"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flushPara(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // a wrapped continuation line stays with its item
          if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += "<br>" + inline(lines[i].trim()); i++; continue; }
          break;
        }
        items.push(inline(m[1]));
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length) {
        const m2 = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (!m2) break;
        buf.push(m2[1]);
        i++;
      }
      out.push(`<blockquote>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join("");
}

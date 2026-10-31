import { Marked, type Tokens } from 'marked';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_HREF = /^(https?:|mailto:)/i;

// Artifacts are model-written and partly derived from web pages, so the
// report treats them as untrusted: raw HTML becomes text, images are
// dropped, and only web and mail links keep their href.
const renderer = new Marked({
  gfm: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    image(token: Tokens.Image): string {
      return escapeHtml(token.text || token.title || '');
    },
    link(token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens);
      if (!SAFE_HREF.test(token.href)) return inner;
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

export function renderMarkdown(md: string): string {
  const html = renderer.parse(md, { async: false }) as string;
  return html.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>');
}

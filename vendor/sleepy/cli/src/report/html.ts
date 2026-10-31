import type { ReportData, ReportItem } from './collect.js';
import { escapeHtml as esc } from './markdown.js';

const KIND_LABEL: Record<ReportItem['type'], string> = {
  code: 'Branch',
  research: 'Research',
  plans: 'Plan',
  content: 'Text',
  findings: 'Findings',
};

const KIND_COLOR: Record<ReportItem['type'], string> = {
  code: 'code',
  research: 'research',
  plans: 'research',
  findings: 'research',
  content: 'content',
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function number(n: number): string {
  return n.toLocaleString('en-US');
}

function metaLine(item: ReportItem): string {
  const parts = [KIND_LABEL[item.type]];
  if (item.addedAt) parts.push(esc(item.addedAt));
  if (item.branch) parts.push(esc(item.size));
  if (item.artifact) parts.push(`${Math.max(1, Math.round(item.artifact.words / 230))} min read`);
  if (item.approved) parts.push('already approved');
  if (item.artifact && !item.artifact.summaryFound) parts.push('no summary written, this is the opening');
  if (item.artifact?.truncated) parts.push('truncated at 512 KB');
  return parts.join(', ');
}

function copyButton(label: string, text: string, quiet = false): string {
  return `<button type="button" class="copy${quiet ? ' quiet' : ''}" data-copy="${esc(text)}">${esc(label)}</button>`;
}

function branchItem(item: ReportItem, data: ReportData): string {
  const b = item.branch!;
  const actions = [copyButton('Copy: try it', `git switch ${b.name}`)];
  if (b.head && !item.approved) actions.push(copyButton('Copy: integrate', `sleepy review --integrate ${item.number} --head ${b.head} --target ${b.targetBranch}`));
  actions.push(copyButton('Copy: continue from here', `Look at branch ${b.name} in ${data.root} (sleepy built it for ${data.project}). Tell me what it changes and what is still open, then propose how to continue.`, true));
  const stat = b.stat.trim();
  const statHtml = stat
    ? `<pre class="stat">${esc(stat)}</pre>`
    : item.approved
      ? `<p class="branch">Already in <code>${esc(b.targetBranch)}</code>: nothing left to diff.</p>`
      : `<p class="note">No changes against <code>${esc(b.targetBranch)}</code>.</p>`;
  return `<article class="item" id="item-${item.number}" data-id="${item.number}" style="--kind: var(--${KIND_COLOR[item.type]})">
  <h3 class="title">${esc(item.title)}</h3>
  <p class="meta"><span class="dot"></span>${metaLine(item)}</p>
  <p class="branch"><code>${esc(b.name)}</code> onto <code>${esc(b.targetBranch)}</code></p>
  ${statHtml}
  <div class="actions">${actions.join('')}</div>
</article>`;
}

function artifactItem(item: ReportItem, data: ReportData): string {
  const a = item.artifact!;
  const prompt = `Read ${a.absolutePath} (a ${KIND_LABEL[item.type].toLowerCase()} that sleepy wrote for ${data.project}). Tell me what has been built from it and what is still open, then propose how to continue.`;
  return `<article class="item" id="item-${item.number}" data-id="${item.number}" style="--kind: var(--${KIND_COLOR[item.type]})">
  <h3 class="title">${esc(a.title)}</h3>
  <p class="meta"><span class="dot"></span>${metaLine(item)}</p>
  <div class="summary md">${a.summaryHtml}</div>
  <div class="actions">
    <button type="button" class="open">Read the whole piece</button>
    <button type="button" class="read quiet">Mark as read</button>
    ${copyButton('Copy: continue from here', prompt, true)}
  </div>
  <div class="body md" hidden>${a.bodyHtml}</div>
  <p class="path" hidden>${esc(a.absolutePath)}</p>
</article>`;
}

function errorItem(item: ReportItem): string {
  return `<article class="item error" id="item-${item.number}" data-id="${item.number}">
  <h3 class="title">${esc(item.title)}</h3>
  <p class="meta">${KIND_LABEL[item.type]}, ${esc(item.error ?? 'unknown error')}</p>
</article>`;
}

function section(heading: string, body: string[], empty: string): string {
  return `<section>
<h2>${heading}</h2>
${body.length ? body.join('\n') : `<p class="empty">${empty}</p>`}
</section>`;
}

export function renderReportHtml(data: ReportData): string {
  const built = data.items.filter((i) => i.branch).map((i) => branchItem(i, data));
  const written = data.items.filter((i) => i.artifact).map((i) => artifactItem(i, data));
  const broken = data.items.filter((i) => i.error).map(errorItem);
  const f = data.facts;
  const facts = [
    ['Iterations', number(f.iterations)],
    ['Tokens', number(f.tokensUsed)],
    ...(f.startedAt ? [['Started', when(f.startedAt)]] : []),
    ...(f.deadline ? [['Deadline', when(f.deadline)]] : []),
    ...(f.intensity ? [['Intensity', esc(f.intensity)]] : []),
    ...(f.termination ? [['Ended because', esc(f.termination)]] : []),
  ];
  const storageKey = `sleepy-report:${data.project}:${data.runId ?? 'all'}`;
  const leadScope = data.scope === 'queue' ? 'Whole queue, ' : `Run <code>${esc(data.runId ?? '')}</code>, `;
  const fallbackNote = data.scopeFallback
    ? ` No snapshot exists for run ${esc(data.runId ?? '')}, so this shows the whole queue.`
    : '';
  const builtEmpty = data.scope === 'queue' ? 'No branches in the queue.' : 'No branches this run.';
  const writtenEmpty = data.scope === 'queue' ? 'Nothing written in the queue.' : 'Nothing written this run.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.project)}: what sleepy did</title>
<style>${CSS}</style>
</head>
<body>
<div class="progress" aria-hidden="true"><i id="bar"></i></div>
<main><div class="column">
<a href="#" class="back" id="back" hidden>Back</a>
<h1>What sleepy did<br><span class="project">${esc(data.project)}</span></h1>
<p class="lead">${leadScope}report made ${when(data.generatedAt)}.${f.termination ? ` The run ended because of <em>${esc(f.termination)}</em>.` : ''}${fallbackNote}</p>
${data.goals ? `<blockquote class="goals">${esc(data.goals)}</blockquote>` : ''}
${section('Built', built, builtEmpty)}
${section('Written', written, writtenEmpty)}
${broken.length ? section('Could not be read', broken, '') : ''}
<section>
<h2>Run facts</h2>
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
</section>
<p class="foot">Keys: j and k for the next and previous item, o opens the whole piece, x marks it read.</p>
</div></main>
<script>${CLIENT.replace('__STORAGE_KEY__', () => JSON.stringify(storageKey).replace(/</g, '\\u003C'))}</script>
</body>
</html>
`;
}

const CSS = `
:root { --bg:#E8EDF1; --ink:#14213D; --muted:#56657A; --line:#C2CDD8; --accent:#A9782A; --code:#2F6F5E; --research:#3A5BA0; --content:#8A4B7A;
  --head:"Avenir Next Condensed","Avenir Next","Helvetica Neue",Arial,sans-serif; --ui:"Avenir Next","Helvetica Neue",Arial,sans-serif; --text:Charter,"Iowan Old Style",Georgia,serif; }
@media (prefers-color-scheme: dark) { :root { --bg:#0F1726; --ink:#DCE3EC; --muted:#8C9BB0; --line:#26334A; --accent:#D9A441; --code:#6FBFA8; --research:#8AA8E8; --content:#D59AC4; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:19px/1.62 var(--text); -webkit-font-smoothing:antialiased; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
main { padding:3.5rem 16px 6rem; }
.column { max-width:41rem; margin:0 auto; min-width:0; overflow-wrap:break-word; }
h1 { font:600 clamp(2.6rem,7vw,4rem)/0.98 var(--head); letter-spacing:-0.015em; margin:0 0 1rem; }
h1 .project { color:var(--accent); }
.lead { color:var(--muted); margin:0 0 1.5rem; }
.goals { border-left:3px solid var(--accent); margin:0 0 1.5rem; padding:.2rem 0 .2rem 1rem; color:var(--muted); white-space:pre-wrap; }
h2 { font:600 2rem/1 var(--head); margin:3.5rem 0 .5rem; }
.empty { color:var(--muted); font-style:italic; }
.item { padding:2rem 0 1.8rem; border-bottom:1px solid var(--line); }
.item.done .title, .item.done .summary { opacity:.55; }
.item.expanded .title, .item.expanded .summary { opacity:1; }
.title { font:600 1.55rem/1.14 var(--head); margin:0 0 .5rem; text-wrap:balance; }
.meta { font:500 .82rem/1.4 var(--ui); color:var(--muted); margin:0 0 1rem; }
.dot { display:inline-block; width:.62rem; height:.62rem; border-radius:2px; background:var(--kind, var(--muted)); margin-right:.45rem; vertical-align:-1px; }
.branch { font:500 .9rem/1.5 var(--ui); margin:0 0 .6rem; }
.note { font:500 .9rem/1.5 var(--ui); color:var(--muted); margin:0 0 .6rem; }
.stat { font:.78rem/1.45 ui-monospace,"SF Mono",Menlo,monospace; color:var(--muted); background:color-mix(in srgb,var(--ink) 7%,transparent); padding:.7rem .9rem; border-radius:5px; overflow-x:auto; margin:0; }
.actions { display:flex; flex-wrap:wrap; gap:.2rem 1.3rem; margin-top:1rem; }
.actions button { font:600 .84rem/1 var(--ui); color:var(--ink); background:none; border:0; padding:1rem 0; cursor:pointer; text-decoration:underline; text-decoration-color:var(--accent); text-decoration-thickness:2px; text-underline-offset:4px; }
.actions button:hover { color:var(--accent); }
.actions .quiet { font-weight:500; color:var(--muted); text-decoration-color:var(--line); }
.body { margin-top:1.4rem; padding-top:1.4rem; border-top:1px dashed var(--line); }
.path { font:.72rem/1.4 ui-monospace,"SF Mono",Menlo,monospace; color:var(--muted); word-break:break-all; }
.md > :first-child { margin-top:0; } .md > :last-child { margin-bottom:0; }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md .table { margin:0 0 1rem; }
.md ul, .md ol { padding-left:1.25rem; } .md li { margin-bottom:.4rem; }
.md h1 { display:none; }
.md h2 { font:600 1.35rem/1.2 var(--head); margin:2.2rem 0 .6rem; }
.md h3 { font:600 1.1rem/1.25 var(--head); margin:1.6rem 0 .5rem; }
.md h4, .md h5, .md h6 { font:600 .9rem/1.3 var(--ui); margin:1.3rem 0 .4rem; }
.md a { color:inherit; text-decoration-color:var(--accent); text-underline-offset:3px; }
.md code { font:.8em ui-monospace,"SF Mono",Menlo,monospace; background:color-mix(in srgb,var(--ink) 8%,transparent); padding:.08em .32em; border-radius:3px; word-break:break-word; }
.md pre { background:color-mix(in srgb,var(--ink) 7%,transparent); padding:.9rem 1rem; border-radius:5px; overflow-x:auto; line-height:1.45; }
.md pre code { background:none; padding:0; font-size:.78rem; word-break:normal; }
.md blockquote { border-left:3px solid var(--accent); padding-left:1rem; margin-left:0; color:var(--muted); }
.md hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
.md .table { overflow-x:auto; }
.md table { border-collapse:collapse; font:.8rem/1.45 var(--ui); min-width:100%; }
.md th, .md td { text-align:left; vertical-align:top; padding:.45rem .7rem .45rem 0; border-bottom:1px solid var(--line); }
.md th { font-weight:600; border-bottom-color:var(--ink); }
.facts { display:grid; grid-template-columns:repeat(auto-fill,minmax(11rem,1fr)); gap:1rem 2rem; margin:1rem 0 0; font:500 .9rem/1.4 var(--ui); }
.facts dt { color:var(--muted); } .facts dd { margin:0; font-size:1.2rem; }
.foot { margin-top:4rem; font:500 .82rem/1.6 var(--ui); color:var(--muted); }
.back { display:inline-block; font:600 .84rem/1 var(--ui); color:var(--muted); text-decoration:none; padding:.6rem 0; margin:-1.5rem 0 1rem; }
.back::before { content:"\\2190\\00a0"; }
.progress { position:fixed; inset:0 0 auto 0; height:4px; background:var(--line); z-index:2; }
.progress i { display:block; height:100%; width:0; background:var(--accent); }
@media (max-width:760px) { body { font-size:17.5px; } main { padding-top:2.5rem; } }
@media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
@media print { .progress, .actions, .foot, .back { display:none; } .body[hidden] { display:block; } .summary[hidden] { display:block; } body { background:#fff; color:#000; } .item { break-inside:avoid; } }
`;

const CLIENT = `
(function () {
  var KEY = __STORAGE_KEY__;
  var items = Array.prototype.slice.call(document.querySelectorAll('.item[data-id]'));
  var done = {};
  try { (JSON.parse(localStorage.getItem(KEY)) || []).forEach(function (id) { done[id] = true; }); } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(Object.keys(done))); } catch (e) {} }
  function readable() { return items.filter(function (el) { return el.querySelector('.body'); }); }
  function paint(el) {
    var id = el.getAttribute('data-id'), on = !!done[id];
    el.classList.toggle('done', on);
    var b = el.querySelector('.read'); if (b) b.textContent = on ? 'Mark as unread' : 'Mark as read';
    var all = readable(), n = all.filter(function (x) { return done[x.getAttribute('data-id')]; }).length;
    var bar = document.getElementById('bar'); if (bar) bar.style.width = all.length ? (100 * n / all.length) + '%' : '0';
  }
  function setDone(el, on) { var id = el.getAttribute('data-id'); if (on) done[id] = true; else delete done[id]; save(); paint(el); }
  function toggle(el) {
    var body = el.querySelector('.body'), sum = el.querySelector('.summary'), path = el.querySelector('.path'), btn = el.querySelector('.open');
    if (!body) return;
    var open = body.hidden;
    body.hidden = !open; if (sum) sum.hidden = open; if (path) path.hidden = !open;
    el.classList.toggle('expanded', open);
    if (btn) btn.textContent = open ? 'Collapse' : 'Read the whole piece';
    if (!open) { el.scrollIntoView({ block: 'start' }); setDone(el, true); }
  }
  function copy(text, btn) {
    var before = btn.textContent;
    function ok() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = before; }, 1600); }
    function fallback() {
      var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); ok(); } catch (e) {} t.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }
  items.forEach(function (el) {
    paint(el);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('open')) toggle(el);
      else if (b.classList.contains('read')) setDone(el, !done[el.getAttribute('data-id')]);
      else if (b.classList.contains('copy')) copy(b.getAttribute('data-copy'), b);
    });
  });
  var current = 0;
  function locate() {
    var i = 0;
    while (i < items.length - 1 && items[i].getBoundingClientRect().bottom < 90) i++;
    current = i;
  }
  var waiting = false;
  window.addEventListener('scroll', function () {
    if (waiting) return; waiting = true;
    requestAnimationFrame(function () { waiting = false; locate(); });
  }, { passive: true });
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || !items.length) return;
    var a = document.activeElement; if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    var el = items[current];
    if (e.key === 'j' || e.key === 'k') {
      var top = el.getBoundingClientRect().top;
      var target = e.key === 'j' ? (top > 40 ? current : current + 1) : (top < -40 ? current : current - 1);
      target = Math.min(items.length - 1, Math.max(0, target));
      items[target].scrollIntoView({ block: 'start' }); e.preventDefault();
    } else if (e.key === 'o') { toggle(el); e.preventDefault(); }
    else if (e.key === 'x') { if (el.querySelector('.body')) setDone(el, !done[el.getAttribute('data-id')]); }
  });
  // The page is often reached from a dashboard link; offer a way back only when there is one.
  var back = document.getElementById('back');
  if (back && window.history.length > 1) {
    back.hidden = false;
    back.addEventListener('click', function (e) { e.preventDefault(); window.history.back(); });
  }
  locate();
})();
`;

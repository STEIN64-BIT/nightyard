// Runs the real pane in an isolated Electron window with fake process APIs.
// No agent processes, user state, or existing Nightyard windows are touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepy-pane-smoke-'));
    try {
      await require('esbuild').build({
        entryPoints: [path.resolve('src/renderer/components/sleepy/sleepy-pane.ts')],
        bundle: true, platform: 'browser', format: 'iife', globalName: 'SleepyPane',
        outfile: path.join(dir, 'pane.js'),
        plugins: [{ name: 'fake-state', setup(build) {
          build.onResolve({ filter: /^\.\.\/\.\.\/state\.js$/ }, () => ({ path: 'state', namespace: 'fake' }));
          build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `
            export const appState = { preferences: { sleepyBin: '/fake/sleepy.mjs' }, on: () => () => {} };
            export const sleepyAutoStartSessions = new Set();
            export const sleepyInitialPrompts = new Map();
            export const sleepyInitialArgs = new Map();
          ` }));
        } }],
      });
      const css = fs.readFileSync('src/renderer/styles/sleepy.css', 'utf8');
      fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><style>
        :root { --bg-primary:#141619; --bg-secondary:#1c1f24; --bg-tertiary:#252a31; --text-primary:#f2f3f5; --text-secondary:#bfc5ce; --text-muted:#949ba7; --accent:#baa3ff; --border:#353b45; --color-warning:#f7bd6a; }
        * {box-sizing:border-box} body {margin:0;height:100vh;background:var(--bg-primary);font:14px system-ui;color:var(--text-primary)}
        ${css}</style><script src="pane.js"></script>`);
      const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, SLEEPY_PANE_SMOKE_DIR: dir }, stdio: 'inherit', timeout: 30000,
      });
      process.exitCode = result.status ?? 1;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  })().catch(err => { console.error(err); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const dir = process.env.SLEEPY_PANE_SMOKE_DIR;
  app.setPath('userData', path.join(dir, 'user-data'));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 860, height: 620, show: false, webPreferences: { offscreen: true } });
    await win.loadFile(path.join(dir, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = (ok, why) => { if (!ok) throw new Error(why); };
      const calls = []; let data; let exit; let unsubscribed = 0;
      window.nightyard = { sleepy: {
        spawn: async (id, opts) => { calls.push(opts); return {pid:1}; }, kill: async () => {},
        onData: (id, cb) => { data = cb; return () => { unsubscribed++; }; },
        onExit: (id, cb) => { exit = cb; return () => { unsubscribed++; }; },
        distill: async () => 'sleepy-summary.md',
      }, app: { openExternal: async () => {} } };
      const handle = SleepyPane.buildSleepyPane({name:'Nightyard',path:'/fixture'}, {id:'test',name:'Sleepy'});
      document.body.appendChild(handle.pane);
      const pane = handle.pane;
      const go = pane.querySelector('.sleepy-go-btn');
      const mode = pane.querySelector('[data-mode]');
      mode.value = 'duo'; mode.dispatchEvent(new Event('change'));
      pane.querySelector('textarea').value = 'Improve the dashboard and verify the result';
      go.click(); await Promise.resolve();
      assert(calls[0].args.includes('--team') && calls[0].args[0] === 'start', 'Duo launch');
      assert(calls[0].cwd === '/fixture', 'Project fixed to the current dashboard');
      assert(pane.querySelector('[data-action="apply"]').disabled, 'Queue action disabled during run');
      assert(mode.disabled, 'Team disabled during run');
      for(let i=0;i<1000;i++) data({chunk:'Step ' + i + ': checking project files\\n',stream:'stdout'});
      assert(pane.querySelector('.sleepy-output').childNodes.length <= 600, 'Output stays bounded');
      go.click(); await Promise.resolve();
      assert(go.disabled && go.textContent === 'Stopping…', 'Stop stays pending until actual exit');
      exit({code:0}); await Promise.resolve();
      assert(!go.disabled && pane.querySelector('[data-status]').textContent === 'Stopped', 'Stopped state');
      const count = calls.length;
      pane.querySelector('[data-n]').value = '1.5'; pane.querySelector('[data-action="apply"]').click();
      assert(calls.length === count, 'Invalid queue number rejected');
      handle.unsubGoal(); assert(unsubscribed >= 2, 'Subscriptions cleaned up');
      const preview = SleepyPane.buildSleepyPane({name:'Nightyard',path:'/fixture'}, {id:'preview',name:'Sleepy'});
      document.body.replaceChildren(preview.pane);
      preview.pane.querySelector('[data-mode]').value = 'duo';
      preview.pane.querySelector('[data-mode]').dispatchEvent(new Event('change'));
      preview.pane.querySelector('textarea').value = 'Improve the dashboard and verify the result';
      preview.pane.querySelector('.sleepy-go-btn').click();
      data({chunk:'sleepy duo: Codex implementing + Opus investigating in parallel\\n\\n  Codex · Improving the dashboard interactions\\n  Opus  · Reviewing edge cases and tests\\n',stream:'stdout'});
      return 'PASS: Duo launch, project scope, queue guards, bounded output, Stop lifecycle, cleanup';
    })()`);
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync('/tmp/nightyard-sleepy-pane.png', (await win.webContents.capturePage()).toPNG());
    console.log(result);
    app.exit(0);
  }).catch(err => { console.error(err); app.exit(1); });
}

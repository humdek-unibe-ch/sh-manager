// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Self-contained bootstrap wizard UI.
 *
 * Returned as a single HTML string (no build step / no npm UI deps, matching
 * the manager's dependency-light ethos). It drives the JSON API exposed by the
 * server. Kept intentionally small: the testable logic lives in the wizard
 * state machine and the server, not here.
 */
export interface RenderOptions {
  mode: 'bootstrap' | 'persistent';
}

export function renderWizardHtml(opts: RenderOptions): string {
  const title = opts.mode === 'persistent' ? 'SelfHelp Manager' : 'SelfHelp Server Bootstrap';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .step { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .ok { color: #1a7f37; } .warn { color: #9a6700; } .err { color: #cf222e; }
  button { padding: .5rem 1rem; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
  input, select { padding: .4rem; width: 100%; box-sizing: border-box; margin: .25rem 0 .75rem; }
  label { font-weight: 600; font-size: .9rem; }
  pre { background: #8881; padding: .75rem; border-radius: 6px; overflow: auto; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>Step: <strong id="step">…</strong></p>
<div class="step" id="panel"></div>
<div>
  <button id="back">Back</button>
  <button id="next">Next</button>
</div>
<h3>State</h3>
<pre id="state"></pre>
<script>
const $ = (id) => document.getElementById(id);
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function render(s) {
  $('step').textContent = s.step + ' (' + (s.stepIndex + 1) + '/' + s.steps.length + ')';
  $('state').textContent = JSON.stringify(s, null, 2);
  const p = $('panel');
  const checkSteps = ['docker','internet','registry','resources'];
  if (checkSteps.includes(s.step)) {
    const c = s.checks[s.step];
    p.innerHTML = '<p>Run the ' + s.step + ' check.</p>' +
      (c ? '<p class="' + (c.severity==='error'?'err':c.severity==='warning'?'warn':'ok') + '">' + (c.detail||'') + '</p>' : '') +
      '<button id="run">Run check</button>';
    $('run').onclick = async () => { render((await api('/api/check/' + s.step, 'POST')).data); };
  } else if (s.step === 'install') {
    p.innerHTML = '<p>Generate compose/env/secrets, pull images, migrate, create admin, install plugins, health-check.</p><button id="go">Install</button>';
    $('go').onclick = async () => { render((await api('/api/install', 'POST')).data); };
  } else if (s.step === 'done') {
    p.innerHTML = '<p class="ok">Bootstrap complete. Your instance is up.</p>';
  } else {
    p.innerHTML = configForm(s);
    p.querySelectorAll('[data-key]').forEach((el) => {
      el.onchange = async () => {
        const v = el.type === 'number' ? Number(el.value) : el.value;
        render((await api('/api/config', 'POST', { [el.dataset.key]: v })).data);
      };
    });
  }
}
function field(label, key, val, type) {
  return '<label>' + label + '</label><input data-key="' + key + '" type="' + (type||'text') + '" value="' + (val??'') + '" />';
}
function configForm(s) {
  const c = s.config;
  switch (s.step) {
    case 'install_root': return field('Install root', 'root', c.root);
    case 'mode': return '<label>Mode</label><select data-key="mode"><option' + (c.mode==='production'?' selected':'') + '>production</option><option' + (c.mode==='local'?' selected':'') + '>local</option></select>' + field('Server id', 'serverId', c.serverId);
    case 'domain': return c.mode === 'production' ? field('Public domain', 'domain', c.domain) + field("Let's Encrypt email", 'letsencryptEmail', c.letsencryptEmail) : field('Localhost port', 'localPort', c.localPort, 'number');
    case 'proxy': return '<p>A shared Traefik proxy/router will be configured for this server.</p>';
    case 'instance': return field('Instance id', 'instanceId', c.instanceId) + field('Display name', 'instanceName', c.instanceName) + field('Registry URL', 'registryUrl', c.registryUrl);
    case 'admin': return field('Admin email (optional)', 'adminEmail', c.adminEmail) + field('Admin name', 'adminName', c.adminName);
    case 'welcome': return '<p>This wizard provisions the first SelfHelp instance on this server.</p>';
    default: return '<p>' + s.step + '</p>';
  }
}
$('next').onclick = async () => {
  const r = await api('/api/advance', 'POST');
  if (r.status >= 400) { alert(r.data.error || 'Cannot advance'); }
  render((await api('/api/state')).data);
};
$('back').onclick = async () => { render((await api('/api/back', 'POST')).data); };
(async () => { render((await api('/api/state')).data); })();
</script>
</body>
</html>`;
}

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view'), nav = $('#nav');
const S = { token: localStorage.getItem('pd_token'), email: localStorage.getItem('pd_email'), base: location.origin };
let timer = null;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString() : '';
const campaignStatus = (status) => ({
  completed: { label: 'completed', className: 'ok' },
  completed_with_errors: { label: 'completed with errors', className: 'bad' },
  failed: { label: 'failed', className: 'bad' }
}[status] || { label: status, className: '' });

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { logout(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function logout() { localStorage.removeItem('pd_token'); localStorage.removeItem('pd_email'); S.token = null; location.hash = '#/login'; }
function saveAuth(j) { S.token = j.token; S.email = j.email; localStorage.setItem('pd_token', j.token); localStorage.setItem('pd_email', j.email); location.hash = '#/'; }
function copy(text, btn) { navigator.clipboard.writeText(text).then(() => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1200); }); }
window.copyText = copy;

function renderNav() {
  document.body.classList.toggle('auth-mode', !S.token);
  nav.innerHTML = S.token ? `<div class="account-avatar">${esc((S.email || 'U').slice(0, 1).toUpperCase())}</div>
    <div class="account-info">${esc(S.email)}<small>Workspace owner</small></div><button class="btn sec sm" id="lo">Log out</button>` : '';
  const lo = $('#lo'); if (lo) lo.onclick = logout;
}
function setActiveNav(route) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === route);
  });
  const labels = { '/': 'Overview', sites: 'Websites', campaigns: 'Campaigns', subscribers: 'Subscribers',
    integration: 'Integration', templates: 'Templates', analytics: 'Analytics', api: 'API access' };
  const label = $('#page-label');
  if (label) label.textContent = labels[route] || 'Overview';
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-scrim').classList.remove('open');
}
$('#menu-toggle').onclick = () => {
  $('#sidebar').classList.toggle('open');
  $('#sidebar-scrim').classList.toggle('open');
};
$('#sidebar-scrim').onclick = closeSidebar;
$('#side-nav').addEventListener('click', (ev) => {
  if (ev.target.closest('a')) closeSidebar();
});
$('#site-picker').onchange = (ev) => {
  const id = ev.target.value;
  if (!id) return;
  localStorage.setItem('pd_site', id);
  location.hash = `#/site/${id}/overview`;
};

// ---------- auth ----------
function authView(mode) {
  const signup = mode === 'signup';
  view.innerHTML = `<div class="card" style="max-width:400px;margin:40px auto"><h2>${signup ? 'Create account' : 'Login'}</h2>
  <form id="f"><label>Email</label><input name="email" type="email" required autofocus>
  <label>Password</label><input name="password" type="password" required minlength="${signup ? 8 : 1}">
  <div style="margin-top:16px" class="row"><button class="btn">${signup ? 'Sign up' : 'Login'}</button>
  <a href="#/${signup ? 'login' : 'signup'}">${signup ? 'Have an account?' : 'Create account'}</a></div><div class="err" id="e"></div></form></div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    try { saveAuth(await api('/auth/' + (signup ? 'signup' : 'login'), 'POST', { email: f.get('email'), password: f.get('password') })); }
    catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------- sites list ----------
async function sitesView() {
  const sites = await api('/sites');
  view.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Your sites</h2></div>
  <div class="card"><form id="f" class="row"><input class="grow" name="name" placeholder="Site name" required>
  <input class="grow" name="domain" placeholder="example.com (optional)"><button class="btn">Add site</button></form><div class="err" id="e"></div></div>
  <div class="grid g2">${sites.map((s) => `<a class="card" href="#/site/${s.id}/overview" style="color:inherit">
    <h3>${esc(s.name)}</h3><div class="muted">${esc(s.domain || 'no domain set')}</div>
    <div class="row" style="margin-top:10px"><span class="pill">${s.subscribers} subscribers</span><span class="pill">${s.campaigns} campaigns</span></div></a>`).join('') || '<p class="muted">No sites yet. Add your first one above.</p>'}</div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    try { const s = await api('/sites', 'POST', { name: f.get('name'), domain: f.get('domain') }); location.hash = `#/site/${s.id}/integration`; }
    catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------- site view ----------
const TABS = ['overview', 'integration', 'send', 'campaigns', 'subscribers', 'templates', 'api'];
async function siteView(id, tab) {
  if (!TABS.includes(tab)) tab = 'overview';
  const site = await api('/sites/' + id);
  view.innerHTML = `<div class="row" style="margin-bottom:8px"><a href="#/">&larr; Sites</a></div><h2>${esc(site.name)} <span class="muted" style="font-size:14px">${esc(site.domain)}</span></h2>
  <div class="tabs">${TABS.map((t) => `<a href="#/site/${id}/${t}" class="${t === tab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}</div><div id="tab"></div>`;
  const el = $('#tab');
  await ({ overview, integration, send, campaigns, subscribers, templates, api: apiTab }[tab])(el, site);
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows.length ? rows.slice(0, 5).map((r) => `<div class="bar"><span class="bar-label">${esc(r.label)}</span><i style="width:${Math.max(3, r.n / max * 100)}%"></i><em>${r.n}</em></div>`).join('') : '<p class="muted">No data yet</p>';
}
async function dashboardView(sites) {
  const el = view;
  if (!sites.length) {
    el.innerHTML = `<div class="page-heading"><div><h1>Welcome to PushDesk</h1><p>Your web push workspace starts with a website.</p></div></div>
      <div class="card empty-state"><span class="empty-icon">◎</span><b>Add your first website</b><p>Connect a site to collect subscribers, send campaigns and view analytics.</p>
      <a class="btn" style="margin-top:14px" href="#/sites">Add a website</a></div>`;
    return;
  }
  const data = await Promise.all(sites.map(async (site) => {
    const [stats, campaigns, audience] = await Promise.all([
      api(`/sites/${site.id}/stats`), api(`/sites/${site.id}/campaigns`), api(`/sites/${site.id}/subscribers?page=1`)
    ]);
    return { site, stats, campaigns, audience };
  }));
  const totals = data.reduce((sum, x) => ({
    active: sum.active + x.stats.totals.active,
    campaigns: sum.campaigns + x.stats.totals.campaigns,
    sent: sum.sent + x.stats.totals.sent,
    clicks: sum.clicks + x.stats.totals.clicks
  }), { active: 0, campaigns: 0, sent: 0, clicks: 0 });
  const ctr = totals.sent ? (totals.clicks / totals.sent * 100).toFixed(1) : '0.0';
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const count = data.reduce((sum, x) => sum + (((x.stats.daily.find((item) => item.d === date) || {}).n) || 0), 0);
    daily.push({ date, count: count || 0 });
  }
  const peak = Math.max(1, ...daily.map((x) => x.count));
  const breakdown = (field) => {
    const counts = {};
    data.forEach((x) => (x.stats.breakdown[field] || []).forEach((row) => {
      counts[row.label] = (counts[row.label] || 0) + row.n;
    }));
    return Object.entries(counts).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  };
  const recentCampaigns = data.flatMap((x) => x.campaigns.map((campaign) => ({ ...campaign, siteName: x.site.name, siteId: x.site.id })))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  const recentSubscribers = data.flatMap((x) => x.audience.rows.map((subscriber) => ({ ...subscriber, siteName: x.site.name })))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  const campaignRows = recentCampaigns.length ? recentCampaigns.map((c) => `<tr>
    <td><b>${esc(c.title)}</b><div class="muted">${esc(c.siteName)}</div></td>
    <td><span class="pill ${campaignStatus(c.status).className}">${esc(campaignStatus(c.status).label)}</span></td>
    <td>${Number(c.sent).toLocaleString()}</td><td>${Number(c.clicks).toLocaleString()}</td>
    <td>${esc(fmt(c.created_at))}</td></tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><b>No campaigns yet</b><p>Create your first campaign to get started.</p></div></td></tr>';
  const subscriberRows = recentSubscribers.length ? recentSubscribers.map((s) => `<tr>
    <td><b>${esc(s.browser || 'Unknown browser')}</b><div class="muted">${esc(s.siteName)}</div></td>
    <td>${esc(s.device || 'Unknown')}</td><td>${esc(s.country || 'Unknown')}</td><td>${esc(fmt(s.created_at))}</td></tr>`).join('') :
    '<tr><td colspan="4"><div class="empty-state"><b>No subscribers yet</b><p>New subscribers will appear here.</p></div></td></tr>';
  el.innerHTML = `<div class="page-heading"><div><h1>Welcome back, ${esc((S.email || '').split('@')[0])} <span aria-hidden="true">👋</span></h1>
    <p>Here’s what’s happening with your push notifications today.</p></div><a class="btn" href="#/site/${sites[0].id}/send">＋ Send campaign</a></div>
    <div class="grid g4">
      <div class="card stat"><div class="stat-icon">♧</div><div><b>${totals.active.toLocaleString()}</b><span>Active subscribers</span></div></div>
      <div class="card stat"><div class="stat-icon">➤</div><div><b>${totals.campaigns.toLocaleString()}</b><span>Campaigns sent</span></div></div>
      <div class="card stat"><div class="stat-icon">▣</div><div><b>${totals.sent.toLocaleString()}</b><span>Notifications delivered</span></div></div>
      <div class="card stat"><div class="stat-icon">◎</div><div><b>${ctr}%</b><span>Click rate · ${totals.clicks.toLocaleString()} clicks</span></div></div>
    </div>
    <div class="dashboard-grid">
      <div>
        <section class="card"><div class="section-head"><div><h3>Subscriber growth</h3><p>New subscribers in the last 14 days · all websites</p></div><span class="pill">Last 14 days</span></div>
          <div class="chart">${daily.map((x) => `<div title="${x.date}: ${x.count} subscribers" style="height:${Math.max(3, x.count / peak * 100)}%"></div>`).join('')}</div>
          <div class="chart-labels"><span>${daily[0].date.slice(5)}</span><span>${daily[6].date.slice(5)}</span><span>${daily[daily.length - 1].date.slice(5)}</span></div>
        </section>
        <section class="card"><div class="section-head"><div><h3>Recent campaigns</h3><p>Your latest notification campaigns</p></div><a class="btn text-btn" href="#/campaigns">View all</a></div>
          <div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Delivered</th><th>Clicks</th><th>Date</th></tr></thead><tbody>${campaignRows}</tbody></table></div>
        </section>
        <section class="card"><div class="section-head"><div><h3>Recent subscribers</h3><p>Latest browsers subscribed to your websites</p></div><a class="btn text-btn" href="#/subscribers">View all</a></div>
          <div class="table-wrap"><table><thead><tr><th>Browser / website</th><th>Device</th><th>Country</th><th>Joined</th></tr></thead><tbody>${subscriberRows}</tbody></table></div>
        </section>
      </div>
      <div>
        <section class="card"><div class="section-head"><div><h3>Subscriber browsers</h3><p>Browser distribution across your audience</p></div><span class="nav-icon">♧</span></div>
          <div class="breakdown-list">${bars(breakdown('browser'))}</div>
        </section>
        <section class="card"><div class="section-head"><div><h3>Top operating systems</h3><p>Where your audience subscribes</p></div><span class="nav-icon">▥</span></div>
          <div class="breakdown-list">${bars(breakdown('os'))}</div>
        </section>
        <section class="card"><div class="section-head"><div><h3>Your websites</h3><a class="btn text-btn" href="#/sites">Manage</a></div></div>
          ${sites.slice(0, 5).map((site) => `<a class="site-row" href="#/site/${site.id}/overview"><span class="site-row-icon">◎</span><span class="grow"><b>${esc(site.name)}</b><small>${esc(site.domain || 'Domain not set')}</small></span><span class="site-row-count">${Number(site.subscribers).toLocaleString()}</span></a>`).join('')}
        </section>
      </div>
    </div>
    <section class="quick-actions">
      <a class="quick-action" href="#/integration"><span class="quick-action-icon">⌘</span><b>Integrate website</b><span>Add the script and start collecting subscribers.</span></a>
      <a class="quick-action" href="#/site/${sites[0].id}/send"><span class="quick-action-icon">➤</span><b>Create campaign</b><span>Send a notification to your subscribers.</span></a>
      <a class="quick-action" href="#/templates"><span class="quick-action-icon">▤</span><b>Notification templates</b><span>Save reusable campaign content.</span></a>
      <a class="quick-action" href="#/api"><span class="quick-action-icon">⌁</span><b>API access</b><span>Send notifications programmatically.</span></a>
    </section>`;
}
async function overview(el) {
  const id = location.hash.split('/')[2];
  const st = await api(`/sites/${id}/stats`);
  const t = st.totals, ctr = t.sent ? (t.clicks / t.sent * 100).toFixed(1) : '0.0';
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ d, n: (st.daily.find((x) => x.d === d) || {}).n || 0 }); }
  const max = Math.max(1, ...days.map((x) => x.n));
  el.innerHTML = `<div class="row" style="justify-content:space-between;margin:6px 0 18px"><div><h1>Website overview</h1><p class="muted" style="margin:0">Monitor subscribers and campaign performance in one place.</p></div><a class="btn" href="#/site/${id}/send">＋ Create campaign</a></div>
  <div class="grid g4"><div class="card stat"><b>${t.active.toLocaleString()}</b><span>Active subscribers</span></div>
  <div class="card stat"><b>${t.campaigns.toLocaleString()}</b><span>Total campaigns</span></div><div class="card stat"><b>${t.sent.toLocaleString()}</b><span>Notifications delivered</span></div>
  <div class="card stat"><b>${ctr}%</b><span>Click rate · ${t.clicks.toLocaleString()} clicks</span></div></div>
  <div class="card"><div class="row" style="justify-content:space-between"><div><h3>Subscriber growth</h3><p class="muted" style="margin:0 0 12px">New subscribers over the last 14 days</p></div><span class="pill">Last 14 days</span></div><div class="chart">${days.map((x) => `<div title="${x.d}: ${x.n} subscribers" style="height:${Math.max(3,x.n / max * 100)}%"></div>`).join('')}</div><div class="row muted" style="justify-content:space-between;font-size:12px;margin-top:8px"><span>${days[0].d}</span><span>${days[days.length-1].d}</span></div></div>
  <div class="grid g2">${['browser', 'os', 'device', 'country', 'language'].map((f) => `<div class="card"><h3>${f[0].toUpperCase() + f.slice(1)} breakdown</h3>${bars(st.breakdown[f])}</div>`).join('')}</div>
  <div class="card"><h3>Quick actions</h3><p class="muted">Get your website connected and send your first notification.</p><div class="row"><a class="btn" href="#/site/${id}/integration">Set up integration</a><a class="btn sec" href="#/site/${id}/send">Create campaign</a><a class="btn sec" href="#/site/${id}/subscribers">View subscribers</a><a class="btn sec" href="#/site/${id}/templates">Manage templates</a></div></div>`;
}

async function integration(el, site) {
  const me = await api('/me'); const base = me.base_url;
  const snippet = `<script src="${base}/sdk/${site.site_key}.js" async></script>`;
  el.innerHTML = `<div class="card"><h3>1. Upload the service worker</h3>
  <p class="muted">Download this file and upload it to the <b>root</b> of your website so it is reachable at <code>https://${esc(site.domain || 'yoursite.com')}/pushdesk-sw.js</code>.</p>
  <a class="btn" href="/pushdesk-sw.js" download>Download pushdesk-sw.js</a></div>
  <div class="card"><h3>2. Add the script to your pages</h3><p class="muted">Paste before <code>&lt;/body&gt;</code>. It shows an opt-in prompt automatically.</p>
  <pre>${esc(snippet)}</pre><button class="btn sm" onclick='copyText(${JSON.stringify(snippet)},this)'>Copy</button>
  <p class="muted" style="margin-top:14px">Want your own button? Set <code>window.PUSHDESK_NO_PROMPT=true</code> before the script, then call <code>PushDesk.subscribe()</code> from a click handler. The popup also collects email signups in this dashboard.</p></div>
  <div class="card"><h3>3. Test it</h3><p class="muted">Preview the push and email signup popup, then subscribe a browser to test campaign delivery. Email addresses are saved in Subscribers; email sending needs a separate delivery provider.</p>
  <a class="btn sec" target="_blank" href="/demo/${site.site_key}">Open test page</a></div>
  <div class="card"><h3 style="color:var(--bad)">Danger zone</h3><button class="btn danger sm" id="del">Delete this site and all its data</button></div>`;
  $('#del').onclick = async () => { if (confirm('Delete site, subscribers and campaigns permanently?')) { await api('/sites/' + site.id, 'DELETE'); location.hash = '#/'; } };
}

async function send(el, site) {
  const [st, tpls] = await Promise.all([api(`/sites/${site.id}/stats`), api('/templates')]);
  const seg = (f) => `<div class="campaign-segment-group"><b>${f[0].toUpperCase() + f.slice(1)}</b><div class="chk">${st.breakdown[f].map((r) => `<label><input type="checkbox" data-f="${f}" value="${esc(r.label)}"> ${esc(r.label)} (${r.n})</label>`).join('') || '<span class="muted">No subscribers yet</span>'}</div></div>`;
  el.innerHTML = `<div class="campaign-builder">
    <header class="campaign-builder-topbar">
      <div class="campaign-builder-brand">Campaign <span>Builder</span></div>
      <nav class="campaign-builder-nav" aria-label="Campaign builder sections">
        <button class="active" type="button" data-scroll="campaign-compose">Compose</button>
        <button type="button" data-scroll="campaign-preview">Preview</button>
        <button type="button" data-settings>Settings</button>
      </nav>
      <button class="btn orange" type="button" data-submit>Send Campaign <span aria-hidden="true">▶</span></button>
    </header>
    <div class="campaign-builder-layout">
      <section class="campaign-panel" id="campaign-compose">
        <div class="campaign-heading"><span class="campaign-heading-icon" aria-hidden="true">♧</span><div><h2>Compose Campaign</h2><p>Create and customize your push notification campaign.</p></div></div>
        <label class="campaign-field-label" for="tpl">Use template</label>
        <select class="campaign-control" id="tpl"><option value="">Start from scratch</option>${tpls.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
        <form id="f">
          <div class="campaign-field">
            <span class="campaign-field-label">Campaign type</span>
            <div class="campaign-types">
              <button class="campaign-type selected" data-type="product" type="button"><span>🛒</span>Product<br>promotion</button>
              <button class="campaign-type" data-type="offer" type="button"><span>◇</span>Sale / offer</button>
              <button class="campaign-type" data-type="article" type="button"><span>▤</span>Blog / news</button>
              <button class="campaign-type" data-type="general" type="button"><span>↗</span>General link</button>
            </div>
          </div>
          <div class="campaign-field"><label class="campaign-field-label" for="campaign-title">Notification title <span class="campaign-required">*</span><span class="campaign-count" id="campaign-title-count"></span></label>
            <input class="campaign-control" id="campaign-title" name="title" maxlength="120" required placeholder="A short, clear headline"></div>
          <div class="campaign-field"><label class="campaign-field-label" for="campaign-body">Message <span class="campaign-count" id="campaign-body-count"></span></label>
            <textarea class="campaign-control" id="campaign-body" name="body" maxlength="400" placeholder="Add a little more detail for your subscribers"></textarea></div>
          <div class="campaign-field"><label class="campaign-field-label" for="campaign-image">Campaign image URL <span class="campaign-optional">(optional)</span></label>
            <input class="campaign-control" id="campaign-image" name="image" type="url" placeholder="https://example.com/image.jpg">
            <span class="campaign-help">Use a public HTTP or HTTPS image URL.</span>
          </div>
          <div class="campaign-field"><label class="campaign-field-label" for="campaign-button-label">Preview action label</label>
            <select class="campaign-control" id="campaign-button-label"><option>Buy Now</option><option>Shop Now</option><option>View Product</option><option>Claim Offer</option><option>Read More</option><option>Visit Website</option><option>Learn More</option></select>
            <span class="campaign-help">Shown in the illustrative preview only; notification actions depend on the subscriber's browser.</span>
          </div>
          <div class="campaign-field"><label class="campaign-field-label" for="campaign-url">Click destination URL <span class="campaign-optional">(optional)</span></label>
            <input class="campaign-control" id="campaign-url" name="url" type="url" placeholder="https://example.com/page"></div>
          <div class="campaign-field campaign-schedule">
            <label class="campaign-field-label"><input id="campaign-schedule-toggle" type="checkbox"> Schedule this campaign for later</label>
            <input class="campaign-control" id="campaign-schedule-at" type="datetime-local" hidden>
            <span class="campaign-help">Uses your local time. The server must stay running to send scheduled campaigns.</span>
          </div>
          <details class="campaign-advanced" id="advanced">
            <summary>⚙ Advanced options <span class="campaign-optional">(optional)</span></summary>
            <div class="campaign-advanced-inner">
              <div class="campaign-field"><label class="campaign-field-label" for="campaign-icon">Icon URL</label><input class="campaign-control" id="campaign-icon" name="icon" type="url" placeholder="https://example.com/icon.png"></div>
              <div class="campaign-field"><span class="campaign-field-label">Target audience</span><p class="campaign-help">Leave filters empty to send to all active subscribers who opted in and still have a valid browser subscription.</p>
                ${['browser', 'os', 'device', 'country', 'language'].map(seg).join('')}
              </div>
              <div class="campaign-field"><label class="campaign-field-label" for="campaign-page">Subscribed on page containing</label><input class="campaign-control" id="campaign-page" name="page" placeholder="/blog/"></div>
            </div>
          </details>
          <div class="campaign-actions"><button class="btn" id="saveDraft" type="button">▣ Save draft</button><button class="btn orange" type="submit">Send Campaign <span aria-hidden="true">▶</span></button></div>
          <div class="campaign-status" id="campaign-status" role="status" aria-live="polite"></div>
        </form>
      </section>
      <section class="campaign-panel campaign-preview-panel" id="campaign-preview">
        <div class="campaign-preview-head">
          <div class="campaign-preview-heading"><span class="campaign-heading-icon" aria-hidden="true">◉</span><div><h2>Live preview</h2><p>Illustrative notification previews across devices.</p></div></div>
          <div class="campaign-preview-mode"><button class="active" type="button" id="campaign-light">☼ Light</button><button type="button" id="campaign-dark">☾ Dark</button></div>
        </div>
        <div class="campaign-devices">
          <div class="campaign-device campaign-desktop-device">
            <div class="campaign-device-label">▣ &nbsp;Desktop notification</div>
            <div class="campaign-desktop-toast">
              <div class="campaign-toast-origin"><span class="campaign-bell">♟</span><span id="campaign-desktop-origin">your website · now</span><span class="campaign-toast-close">×</span></div>
              <div class="campaign-toast-content"><div class="campaign-toast-copy"><strong id="campaign-desktop-title">Notification title</strong><p id="campaign-desktop-body">Your message will appear here.</p></div><img id="campaign-desktop-image" alt="" hidden></div>
              <a class="campaign-preview-action" href="#" target="_blank" rel="noopener noreferrer">Buy Now</a>
            </div>
          </div>
          <div class="campaign-device campaign-android-device">
            <div class="campaign-device-label">◉ &nbsp;Android notification</div><p class="campaign-device-note">Illustrative notification shade</p>
            <div class="campaign-phone"><div class="campaign-phone-status"><span>10:24</span><span>◆ ▴ ▰</span></div><div class="campaign-phone-time">10:24</div><div class="campaign-phone-date">Tue, Oct 27</div><div class="campaign-quicktiles"><i>●</i><i>ᛒ</i><i>◉</i><i>▣</i></div>
              <div class="campaign-mobile-notification"><div class="campaign-mobile-origin"><span class="campaign-app-dot">♟</span><span id="campaign-android-origin">your website · now</span></div><strong class="campaign-mobile-title">Notification title</strong><p class="campaign-mobile-body">Your message will appear here.</p><img id="campaign-android-image" alt="" hidden><a class="campaign-preview-action" href="#" target="_blank" rel="noopener noreferrer">Buy Now</a></div><div class="campaign-homebar"></div>
            </div>
          </div>
          <div class="campaign-device campaign-ios-device">
            <div class="campaign-device-label">● &nbsp;iOS notification</div><p class="campaign-device-note">Illustrative iPhone lock screen</p>
            <div class="campaign-phone campaign-ios-phone"><div class="campaign-phone-status"><span>9:41</span><span>▮ ▴ ◉</span></div><div class="campaign-ios-date">Tuesday, October 27</div>
              <div class="campaign-mobile-notification"><div class="campaign-mobile-origin"><span class="campaign-app-dot">♟</span><span id="campaign-ios-origin">your website</span><span class="campaign-ios-now">now</span></div><img id="campaign-ios-image" alt="" hidden><strong class="campaign-mobile-title">Notification title</strong><p class="campaign-mobile-body">Your message will appear here.</p><a class="campaign-preview-action" href="#" target="_blank" rel="noopener noreferrer">Buy Now</a></div><div class="campaign-homebar"></div>
            </div>
          </div>
        </div>
        <p class="campaign-preview-note">Illustrative preview only. Actual notification layout and image support vary by browser and operating system.</p>
      </section>
    </div>
  </div>`;
  const f = $('#f');
  const segment = () => { const s = {}; f.querySelectorAll('[data-f]:checked').forEach((c) => (s[c.dataset.f] = s[c.dataset.f] || []).push(c.value)); if (f.elements.page.value) s.page = f.elements.page.value; return s; };
  const scheduleToggle = $('#campaign-schedule-toggle');
  const scheduleAt = $('#campaign-schedule-at');
  const submitButton = f.querySelector('[type="submit"]');
  const headerSubmit = el.querySelector('[data-submit]');
  const updateScheduleControls = () => {
    scheduleAt.hidden = !scheduleToggle.checked;
    scheduleAt.required = scheduleToggle.checked;
    const label = scheduleToggle.checked ? 'Schedule Campaign' : 'Send Campaign';
    submitButton.innerHTML = `${label} <span aria-hidden="true">▶</span>`;
    headerSubmit.innerHTML = `${label} <span aria-hidden="true">▶</span>`;
  };
  const localMin = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  scheduleAt.min = localMin;
  scheduleToggle.addEventListener('change', updateScheduleControls);
  const payload = () => ({
    title: f.elements.title.value.trim(), body: f.elements.body.value, url: f.elements.url.value,
    icon: f.elements.icon.value, image: f.elements.image.value, segment: segment(),
    scheduled_at: scheduleToggle.checked ? new Date(scheduleAt.value).toISOString() : null
  });
  const previewUrl = (value) => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch (_) { return ''; } };
  const updatePreview = () => {
    const title = f.elements.title.value.trim() || 'Notification title';
    const body = f.elements.body.value.trim() || 'Your message will appear here.';
    const url = previewUrl(f.elements.url.value);
    const image = previewUrl(f.elements.image.value);
    const host = url ? new URL(url).host : (site.domain || 'your website');
    $('#campaign-title-count').textContent = `${f.elements.title.value.length}/120`;
    $('#campaign-body-count').textContent = `${f.elements.body.value.length}/400`;
    $('#campaign-desktop-title').textContent = title;
    $('#campaign-desktop-body').textContent = body;
    f.querySelectorAll('.campaign-mobile-title').forEach((node) => { node.textContent = title; });
    f.querySelectorAll('.campaign-mobile-body').forEach((node) => { node.textContent = body; });
    $('#campaign-button-label').value = $('#campaign-button-label').value;
    el.querySelectorAll('.campaign-preview-action').forEach((link) => { link.textContent = $('#campaign-button-label').value; link.href = url || '#'; });
    ['campaign-desktop-origin', 'campaign-android-origin'].forEach((id) => { $(`#${id}`).textContent = `${host} · now`; });
    $('#campaign-ios-origin').textContent = host;
    ['campaign-desktop-image', 'campaign-android-image', 'campaign-ios-image'].forEach((id) => {
      const img = $(`#${id}`);
      img.hidden = !image;
      if (image) img.src = image;
      else img.removeAttribute('src');
    });
  };
  f.addEventListener('input', updatePreview);
  f.addEventListener('change', updatePreview);
  $('#campaign-button-label').addEventListener('change', updatePreview);
  el.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
    el.querySelector(`#${button.dataset.scroll}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el.querySelector('[data-settings]').onclick = () => {
    $('#advanced').open = true;
    $('#advanced').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  el.querySelectorAll('[data-submit]').forEach((button) => button.onclick = () => f.requestSubmit());
  const presets = {
    product: ['Buy Now', 'https://example.com/product'],
    offer: ['Claim Offer', 'https://example.com/offer'],
    article: ['Read More', 'https://example.com/article'],
    general: ['Visit Website', 'https://example.com']
  };
  el.querySelectorAll('.campaign-type').forEach((button) => button.onclick = () => {
    el.querySelectorAll('.campaign-type').forEach((item) => item.classList.toggle('selected', item === button));
    const [label, url] = presets[button.dataset.type];
    $('#campaign-button-label').value = label;
    f.elements.url.value = url;
    updatePreview();
  });
  const draftKey = `pushdesk-campaign-draft-${site.id}`;
  const savedDraft = localStorage.getItem(draftKey);
  if (savedDraft) {
    try {
      const draft = JSON.parse(savedDraft);
      for (const key of ['title', 'body', 'url', 'icon', 'image', 'page']) if (typeof draft[key] === 'string') f.elements[key].value = draft[key];
      if (typeof draft.schedule_local === 'string') scheduleAt.value = draft.schedule_local;
      if (draft.schedule_local) scheduleToggle.checked = true;
      if (draft.segment && typeof draft.segment === 'object') {
        f.querySelectorAll('[data-f]').forEach((checkbox) => { checkbox.checked = Array.isArray(draft.segment[checkbox.dataset.f]) && draft.segment[checkbox.dataset.f].includes(checkbox.value); });
      }
      if (typeof draft.actionLabel === 'string') $('#campaign-button-label').value = draft.actionLabel;
    } catch (e) { $('#campaign-status').textContent = `Could not load saved draft: ${e.message}`; }
  }
  updateScheduleControls();
  $('#saveDraft').onclick = () => {
    try { localStorage.setItem(draftKey, JSON.stringify({ ...payload(), schedule_local: scheduleAt.value, actionLabel: $('#campaign-button-label').value })); $('#campaign-status').textContent = 'Draft saved in this browser.'; }
    catch (e) { $('#campaign-status').textContent = `Could not save draft: ${e.message}`; }
  };
  $('#campaign-light').onclick = () => { el.querySelector('.campaign-builder').classList.remove('is-dark'); $('#campaign-light').classList.add('active'); $('#campaign-dark').classList.remove('active'); };
  $('#campaign-dark').onclick = () => { el.querySelector('.campaign-builder').classList.add('is-dark'); $('#campaign-dark').classList.add('active'); $('#campaign-light').classList.remove('active'); };
  $('#tpl').onchange = (e) => { const t = tpls.find((x) => String(x.id) === e.target.value); if (!t) return; for (const k of ['title', 'body', 'url', 'icon', 'image']) f.elements[k].value = t[k] || ''; updatePreview(); };
  $('#campaign-estimate')?.remove();
  const estimateButton = document.createElement('button');
  estimateButton.className = 'btn sec';
  estimateButton.type = 'button';
  estimateButton.id = 'campaign-estimate';
  estimateButton.textContent = 'Estimate audience';
  f.querySelector('.campaign-actions').prepend(estimateButton);
  estimateButton.onclick = async () => {
    const status = $('#campaign-status');
    status.textContent = 'Calculating audience…';
    try { const result = await api(`/sites/${site.id}/estimate`, 'POST', { segment: segment() }); status.textContent = `${Number(result.count).toLocaleString()} active subscriber(s) match these filters.`; }
    catch (e) { status.textContent = `Could not estimate audience: ${e.message}`; }
  };
  updatePreview();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const status = $('#campaign-status');
    status.textContent = '';
    try {
      const n = (await api(`/sites/${site.id}/estimate`, 'POST', { segment: segment() })).count;
      const campaign = payload();
      const when = campaign.scheduled_at ? ` at ${new Date(campaign.scheduled_at).toLocaleString()}` : '';
      if (!confirm(`${campaign.scheduled_at ? 'Schedule' : 'Send'} to ${n} active opted-in subscriber(s)${when}?`)) return;
      await api(`/sites/${site.id}/campaigns`, 'POST', campaign);
      localStorage.removeItem(draftKey);
      location.hash = `#/site/${site.id}/campaigns`;
    } catch (e) { status.textContent = `Could not submit campaign: ${e.message}`; }
  };
}

async function campaigns(el, site) {
  const rows = await api(`/sites/${site.id}/campaigns`);
  el.innerHTML = `<div class="page-heading"><div><h1>Campaigns</h1><p>Track delivery and engagement for your notifications.</p></div><a class="btn" href="#/site/${site.id}/send">＋ Create campaign</a></div>
  <div class="card campaign-history"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Scheduled for</th><th>Audience</th><th>Delivered</th><th>Failed</th><th>Clicks</th><th>CTR</th><th>Created</th></tr></thead><tbody>
  ${rows.map((c) => `<tr><td><b>${esc(c.title)}</b>${c.status === 'scheduled' ? `<br><button class="btn sm danger" type="button" data-cancel="${esc(c.id)}">Cancel</button>` : ''}</td><td><span class="pill ${campaignStatus(c.status).className}">${esc(campaignStatus(c.status).label)}</span></td>
  <td>${c.scheduled_at ? esc(new Date(Number(c.scheduled_at)).toLocaleString()) : '-'}</td><td>${Number(c.total).toLocaleString()}</td><td>${Number(c.sent).toLocaleString()}</td><td>${Number(c.failed).toLocaleString()}</td><td>${Number(c.clicks).toLocaleString()}</td><td>${c.sent ? (c.clicks / c.sent * 100).toFixed(1) + '%' : '-'}</td><td>${esc(fmt(c.created_at))}</td></tr>`).join('') || '<tr><td colspan="9"><div class="empty-state"><span class="empty-icon">➤</span><b>No campaigns yet</b><p>Create your first campaign to get started.</p><a class="btn" style="margin-top:14px" href="#/site/${site.id}/send">Create campaign</a></div></td></tr>'}</tbody></table></div></div>`;
  el.querySelectorAll('[data-cancel]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Cancel this scheduled campaign?')) return;
      try { await api(`/sites/${site.id}/campaigns/${button.dataset.cancel}/cancel`, 'POST'); await campaigns(el, site); }
      catch (error) { alert(`Could not cancel campaign: ${error.message}`); }
    };
  });
  if (rows.some((c) => c.status === 'sending' || c.status === 'scheduled')) {
    timer = setTimeout(() => campaigns(el, site), rows.some((c) => c.status === 'sending') ? 2000 : 30000);
  }
}

async function subscribers(el, site) {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  const page = parseInt(query.get('page')) || 1, emailPage = parseInt(query.get('email_page')) || 1;
  const [r, emails] = await Promise.all([
    api(`/sites/${site.id}/subscribers?page=${page}`),
    api(`/sites/${site.id}/email-subscribers?page=${emailPage}`)
  ]);
  el.innerHTML = `<div class="page-heading"><div><h1>Subscribers</h1><p>Push subscribers and email signups for ${esc(site.name)}.</p></div></div>
  <div class="card" style="overflow:auto"><h3>Email signups <span class="pill">${emails.total} saved</span></h3><p class="muted">Email addresses are collected with consent. Email delivery is not configured in PushDesk yet.</p><table><thead><tr><th>#</th><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>
  ${emails.rows.map((s) => `<tr><td>${s.id}</td><td>${esc(s.email)}</td><td>${esc(fmt(s.created_at))}</td><td><button class="btn danger sm" type="button" data-remove-email="${esc(s.id)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No email signups yet</td></tr>'}</tbody></table>
  <div class="row" style="margin-top:12px">${emailPage > 1 ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?email_page=${emailPage - 1}">Previous email signups</a>` : ''}${emailPage * emails.size < emails.total ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?email_page=${emailPage + 1}">Next email signups</a>` : ''}</div></div>
  <div class="card" style="overflow:auto"><h3>Push subscribers <span class="pill">${r.total} total</span></h3><table><thead><tr><th>#</th><th>Browser</th><th>OS</th><th>Device</th><th>Country</th><th>Page</th><th>Status</th><th>Joined</th></tr></thead><tbody>
  ${r.rows.map((s) => `<tr><td>${s.id}</td><td>${esc(s.browser)}</td><td>${esc(s.os)}</td><td>${esc(s.device)}</td><td>${esc(s.country)}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.page)}</td>
  <td><span class="pill ${s.active ? 'ok' : 'bad'}">${s.active ? 'active' : 'inactive'}</span></td><td>${esc(fmt(s.created_at))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No push subscribers yet</td></tr>'}</tbody></table>
  <div class="row" style="margin-top:12px">${page > 1 ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?page=${page - 1}">Previous push subscribers</a>` : ''}${page * r.size < r.total ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?page=${page + 1}">Next push subscribers</a>` : ''}</div></div>`;
  el.querySelectorAll('[data-remove-email]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Remove this email signup?')) return;
      try { await api(`/sites/${site.id}/email-subscribers/${button.dataset.removeEmail}`, 'DELETE'); await subscribers(el, site); }
      catch (error) { alert(`Could not remove email signup: ${error.message}`); }
    };
  });
}

async function templates(el) {
  const rows = await api('/templates');
  el.innerHTML = `<div class="grid g2"><div class="card"><h3>New template</h3><form id="f"><label>Template name</label><input name="name" required>
  <label>Title</label><input name="title" required><label>Message</label><textarea name="body" rows="2"></textarea><label>Click URL</label><input name="url" type="url">
  <label>Icon URL</label><input name="icon" type="url"><label>Image URL</label><input name="image" type="url"><div style="margin-top:14px"><button class="btn">Save template</button></div><div class="err" id="e"></div></form></div>
  <div class="card"><h3>Saved templates (shared across your sites)</h3>${rows.map((t) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow"><b>${esc(t.name)}</b><div class="muted">${esc(t.title)}</div></div><button class="btn danger sm" data-d="${t.id}">Delete</button></div>`).join('') || '<p class="muted">None yet</p>'}</div></div>`;
  $('#f').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/templates', 'POST', Object.fromEntries(new FormData(ev.target))); templates(el); } catch (e) { $('#e').textContent = e.message; } };
  el.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => { await api('/templates/' + b.dataset.d, 'DELETE'); templates(el); });
}

async function apiTab(el, site) {
  const base = (await api('/me')).base_url;
  const ex = `curl -X POST ${base}/api/v1/send \\\n  -H "x-api-key: ${site.api_key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Hello","body":"New post is live","url":"https://example.com/post","segment":{"country":["IN","US"],"device":["Mobile"]}}'`;
  el.innerHTML = `<div class="card"><h3>API key</h3><p class="muted">Keep this secret. It can send notifications to this site's subscribers.</p>
  <pre>${esc(site.api_key)}</pre><div class="row"><button class="btn sm" onclick='copyText(${JSON.stringify(site.api_key)},this)'>Copy</button><button class="btn sec sm" id="rot">Regenerate</button></div></div>
  <div class="card"><h3>Send a notification</h3><pre>${esc(ex)}</pre>
  <h3>Other endpoints</h3><pre>GET ${esc(base)}/api/v1/subscribers/count?country=IN&amp;device=Mobile
GET ${esc(base)}/api/v1/campaigns/:id</pre><p class="muted">Pass the key as <code>x-api-key</code> header. Segment fields: browser, os, device, country, language, page.</p></div>`;
  $('#rot').onclick = async () => { if (confirm('Old key stops working immediately. Continue?')) { await api(`/sites/${site.id}/rotate-key`, 'POST'); route(); } };
}

// ---------- router ----------
async function route() {
  clearTimeout(timer); renderNav();
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  try {
    if (parts[0] === 'login' || parts[0] === 'signup') return authView(parts[0]);
    if (!S.token) return (location.hash = '#/login');
    const sites = await api('/sites');
    const picker = $('#site-picker');
    const hashSite = parts[0] === 'site' ? parts[1] : null;
    let selected = hashSite || localStorage.getItem('pd_site') || (sites[0] && String(sites[0].id)) || '';
    if (!sites.some((site) => String(site.id) === String(selected))) selected = sites[0] ? String(sites[0].id) : '';
    if (selected) localStorage.setItem('pd_site', selected);
    picker.innerHTML = sites.length ? sites.map((site) =>
      `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('') : '<option value="">No websites yet</option>';
    picker.value = selected;
    const routeName = parts[0] === 'site'
      ? ({ overview: '/', integration: 'integration', send: 'campaigns', campaigns: 'campaigns',
          subscribers: 'subscribers', templates: 'templates', api: 'api' }[parts[2]] || '/')
      : (parts[0] || '/');
    setActiveNav(routeName);
    closeSidebar();
    if (parts[0] === 'site' && parts[1]) return await siteView(parts[1], parts[2]);
    if (parts[0] === 'sites') return await sitesView();
    if (!sites.length) return await dashboardView(sites);
    if (parts[0] === 'campaigns') return await siteView(selected, 'campaigns');
    if (parts[0] === 'subscribers') return await siteView(selected, 'subscribers');
    if (parts[0] === 'integration') return await siteView(selected, 'integration');
    if (parts[0] === 'templates') {
      view.innerHTML = `<div class="page-heading"><div><h1>Notification templates</h1><p>Save reusable messages and use them in campaigns.</p></div></div><div id="tab"></div>`;
      return await templates($('#tab'));
    }
    if (parts[0] === 'api') return await siteView(selected, 'api');
    if (parts[0] === 'analytics') return await siteView(selected, 'overview');
    if (parts[0] === 'send') return await siteView(selected, 'send');
    return await dashboardView(sites);
  } catch (e) { view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
route();

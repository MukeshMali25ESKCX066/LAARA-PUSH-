require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { all, get, run, initDb, ensureSetting, diagnose } = require('./db');
const { initPush, getPublicKey, sendCampaign, countAudience, SEGMENT_FIELDS } = require('./push');

let waitUntil = null;
if (process.env.VERCEL) { try { waitUntil = require('@vercel/functions').waitUntil; } catch (_) {} }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

let JWT_SECRET = process.env.JWT_SECRET || null;
const ready = (async () => {
  await initDb();
  if (!JWT_SECRET) JWT_SECRET = await ensureSetting('jwt_secret', () => crypto.randomBytes(32).toString('hex'));
  await initPush();
})();
ready.catch((e) => console.error('PushDesk boot failed:', e));
app.get('/api/health', async (req, res) => {
  try { await ready; res.json({ ok: true }); }
  catch (e) {
    let diagnostics = null;
    try { diagnostics = await diagnose(); } catch (_) {}
    res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300), diagnostics });
  }
});
app.use((req, res, next) => ready.then(() => next(), next));

const origin = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const rand = (n) => crypto.randomBytes(n).toString('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
function parseUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobile|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop';
  return { browser, os, device };
}
const clean = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const isUrl = (v) => !v || /^https?:\/\//i.test(v);
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

const auth = wrap(async (req, res, next) => {
  const h = req.get('authorization') || '';
  try {
    const p = jwt.verify(h.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    req.user = await get('SELECT id,email FROM users WHERE id=?', [p.id]);
    if (!req.user) throw new Error('no user');
  } catch (_) { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
});
const ownSite = wrap(async (req, res, next) => {
  const site = await get('SELECT * FROM sites WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  req.site = site; next();
});
const token = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

// ---------- auth ----------
app.post('/api/auth/signup', wrap(async (req, res) => {
  const count = (await get('SELECT COUNT(*) n FROM users')).n;
  if (count > 0 && process.env.ALLOW_SIGNUP === 'false') return res.status(403).json({ error: 'Signups are disabled' });
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (await get('SELECT 1 AS x FROM users WHERE email=?', [email])) return res.status(409).json({ error: 'Email already registered' });
  const { id } = await run('INSERT INTO users(email,password_hash) VALUES(?,?)', [email, bcrypt.hashSync(password, 10)]);
  res.json({ token: token({ id }), email });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const u = await get('SELECT * FROM users WHERE email=?', [email]);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: token(u), email: u.email });
}));
app.get('/api/me', auth, (req, res) => res.json({ ...req.user, base_url: origin(req) }));

// ---------- sites ----------
app.get('/api/sites', auth, wrap(async (req, res) => {
  res.json(await all(`SELECT s.*, (SELECT COUNT(*) FROM subscribers WHERE site_id=s.id AND active=1) AS subscribers,
    (SELECT COUNT(*) FROM campaigns WHERE site_id=s.id) AS campaigns FROM sites s WHERE user_id=? ORDER BY id DESC`, [req.user.id]));
}));
app.post('/api/sites', auth, wrap(async (req, res) => {
  const name = clean(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const domain = clean(req.body.domain, 200).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const { id } = await run('INSERT INTO sites(user_id,name,domain,site_key,api_key) VALUES(?,?,?,?,?)', [req.user.id, name, domain, rand(8), rand(24)]);
  res.json(await get('SELECT * FROM sites WHERE id=?', [id]));
}));
app.get('/api/sites/:id', auth, ownSite, (req, res) => res.json(req.site));
app.delete('/api/sites/:id', auth, ownSite, wrap(async (req, res) => {
  await run('DELETE FROM subscribers WHERE site_id=?', [req.site.id]);
  await run('DELETE FROM email_subscribers WHERE site_id=?', [req.site.id]);
  await run('DELETE FROM campaigns WHERE site_id=?', [req.site.id]);
  await run('DELETE FROM sites WHERE id=?', [req.site.id]);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/rotate-key', auth, ownSite, wrap(async (req, res) => {
  const k = rand(24); await run('UPDATE sites SET api_key=? WHERE id=?', [k, req.site.id]); res.json({ api_key: k });
}));

app.get('/api/sites/:id/stats', auth, ownSite, wrap(async (req, res) => {
  const id = req.site.id;
  const n = async (sql) => (await get(sql, [id])).n;
  const totals = {
    active: await n('SELECT COUNT(*) n FROM subscribers WHERE site_id=? AND active=1'),
    all: await n('SELECT COUNT(*) n FROM subscribers WHERE site_id=?'),
    campaigns: await n('SELECT COUNT(*) n FROM campaigns WHERE site_id=?'),
    sent: await n('SELECT COALESCE(SUM(sent),0) n FROM campaigns WHERE site_id=?'),
    clicks: await n('SELECT COALESCE(SUM(clicks),0) n FROM campaigns WHERE site_id=?')
  };
  const breakdown = {};
  await Promise.all(SEGMENT_FIELDS.map(async (f) => {
    breakdown[f] = await all(`SELECT COALESCE(NULLIF(${f},''),'Unknown') AS label, COUNT(*) AS n FROM subscribers
      WHERE site_id=? AND active=1 GROUP BY label ORDER BY n DESC LIMIT 20`, [id]);
  }));
  const daily = await all(`SELECT date(created_at) d, COUNT(*) n FROM subscribers WHERE site_id=? AND created_at >= date('now','-13 days')
    GROUP BY d ORDER BY d`, [id]);
  res.json({ totals, breakdown, daily });
}));

app.get('/api/sites/:id/subscribers', auth, ownSite, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), size = 50;
  const rows = await all(`SELECT id,browser,os,device,country,language,page,active,created_at,last_seen FROM subscribers
    WHERE site_id=? ORDER BY id DESC LIMIT ? OFFSET ?`, [req.site.id, size, (page - 1) * size]);
  const total = (await get('SELECT COUNT(*) n FROM subscribers WHERE site_id=?', [req.site.id])).n;
  res.json({ rows, total, page, size });
}));
app.get('/api/sites/:id/email-subscribers', auth, ownSite, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), size = 50;
  const rows = await all(`SELECT id,email,active,created_at FROM email_subscribers
    WHERE site_id=? ORDER BY id DESC LIMIT ? OFFSET ?`, [req.site.id, size, (page - 1) * size]);
  const total = (await get('SELECT COUNT(*) n FROM email_subscribers WHERE site_id=?', [req.site.id])).n;
  res.json({ rows, total, page, size });
}));
app.delete('/api/sites/:id/email-subscribers/:eid', auth, ownSite, wrap(async (req, res) => {
  await run('DELETE FROM email_subscribers WHERE id=? AND site_id=?', [req.params.eid, req.site.id]);
  res.json({ ok: true });
}));

// ---------- campaigns ----------
function normalizeSegment(seg = {}) {
  const out = {};
  for (const f of SEGMENT_FIELDS) if (Array.isArray(seg[f]) && seg[f].length) out[f] = seg[f].map(String).slice(0, 50);
  if (seg.page) out.page = clean(seg.page, 200);
  return out;
}
app.post('/api/sites/:id/estimate', auth, ownSite, wrap(async (req, res) => {
  res.json({ count: await countAudience(req.site.id, normalizeSegment(req.body.segment)) });
}));
app.get('/api/sites/:id/campaigns', auth, ownSite, wrap(async (req, res) => {
  res.json(await all('SELECT * FROM campaigns WHERE site_id=? ORDER BY id DESC LIMIT 100', [req.site.id]));
}));
app.post('/api/sites/:id/campaigns/:cid/cancel', auth, ownSite, wrap(async (req, res) => {
  const result = await run("UPDATE campaigns SET status='cancelled' WHERE id=? AND site_id=? AND status='scheduled'",
    [req.params.cid, req.site.id]);
  if (!result.changes) return res.status(409).json({ error: 'Campaign is no longer scheduled' });
  res.json({ ok: true });
}));
async function createCampaign(site, b, req) {
  const title = clean(b.title, 120);
  if (!title) throw httpErr(400, 'Title is required');
  const body = clean(b.body, 400), url = clean(b.url, 1000), icon = clean(b.icon, 1000), image = clean(b.image, 1000);
  if (![url, icon, image].every(isUrl)) throw httpErr(400, 'URLs must start with http:// or https://');
  let scheduledAt = null;
  if (b.scheduled_at) {
    if (typeof b.scheduled_at !== 'string') throw httpErr(400, 'Choose a valid schedule time in the future');
    if (process.env.VERCEL) {
      throw httpErr(501, 'Scheduled campaigns require a persistent Node.js server and are unavailable on Vercel serverless deployments.');
    }
    scheduledAt = Date.parse(b.scheduled_at);
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      throw httpErr(400, 'Choose a valid schedule time in the future');
    }
  }
  const status = scheduledAt ? 'scheduled' : 'sending';
  const { id } = await run('INSERT INTO campaigns(site_id,title,body,url,icon,image,segment,status,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [site.id, title, body, url, icon, image, JSON.stringify(normalizeSegment(b.segment)), status, scheduledAt]);
  if (scheduledAt) return get('SELECT * FROM campaigns WHERE id=?', [id]);
  const job = sendCampaign(id, origin(req)).catch(async (e) => {
    console.error('send failed', e); await run("UPDATE campaigns SET status='failed' WHERE id=?", [id]);
  });
  if (waitUntil) waitUntil(job);
  else if (process.env.VERCEL) await job;
  return get('SELECT * FROM campaigns WHERE id=?', [id]);
}
app.post('/api/sites/:id/campaigns', auth, ownSite, wrap(async (req, res) => res.json(await createCampaign(req.site, req.body, req))));

// ---------- templates ----------
app.get('/api/templates', auth, wrap(async (req, res) => res.json(await all('SELECT * FROM templates WHERE user_id=? ORDER BY id DESC', [req.user.id]))));
app.post('/api/templates', auth, wrap(async (req, res) => {
  const b = req.body, name = clean(b.name, 100), title = clean(b.title, 120);
  if (!name || !title) return res.status(400).json({ error: 'Name and title are required' });
  const { id } = await run('INSERT INTO templates(user_id,name,title,body,url,icon,image) VALUES(?,?,?,?,?,?,?)',
    [req.user.id, name, title, clean(b.body, 400), clean(b.url, 1000), clean(b.icon, 1000), clean(b.image, 1000)]);
  res.json({ id });
}));
app.delete('/api/templates/:tid', auth, wrap(async (req, res) => {
  await run('DELETE FROM templates WHERE id=? AND user_id=?', [req.params.tid, req.user.id]); res.json({ ok: true });
}));

// ---------- developer REST API (x-api-key) ----------
const apiKey = wrap(async (req, res, next) => {
  const k = req.get('x-api-key') || req.query.api_key;
  const site = k && await get('SELECT * FROM sites WHERE api_key=?', [String(k)]);
  if (!site) return res.status(401).json({ error: 'Invalid API key' });
  req.site = site; next();
});
app.post('/api/v1/send', apiKey, wrap(async (req, res) => {
  const c = await createCampaign(req.site, req.body, req); res.json({ campaign_id: c.id, status: c.status });
}));
app.get('/api/v1/subscribers/count', apiKey, wrap(async (req, res) => {
  res.json({ count: await countAudience(req.site.id, normalizeSegment(req.query)) });
}));
app.get('/api/v1/campaigns/:cid', apiKey, wrap(async (req, res) => {
  const c = await get('SELECT id,title,status,total,sent,failed,clicks,created_at FROM campaigns WHERE id=? AND site_id=?', [req.params.cid, req.site.id]);
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
}));

// ---------- public endpoints used by the embed script / service worker ----------
const pub = cors({ origin: true });
app.options('/public/*', pub);
app.post('/public/subscribe', pub, wrap(async (req, res) => {
  const { key, subscription, page, language } = req.body || {};
  const site = key && await get('SELECT * FROM sites WHERE site_key=?', [String(key)]);
  const k = subscription && subscription.keys;
  if (!site || !subscription || !subscription.endpoint || !k || !k.p256dh || !k.auth) return res.status(400).json({ error: 'Invalid request' });
  const ua = parseUA(req.get('user-agent') || '');
  const country = (req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country') || 'Unknown').toUpperCase();
  await run(`INSERT INTO subscribers(site_id,endpoint,p256dh,auth,browser,os,device,country,language,page)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,endpoint) DO UPDATE SET active=1, last_seen=CURRENT_TIMESTAMP,
    p256dh=excluded.p256dh, auth=excluded.auth, page=excluded.page`,
    [site.id, clean(subscription.endpoint, 2000), k.p256dh, k.auth, ua.browser, ua.os, ua.device, country, clean(language, 20), clean(page, 500)]);
  res.json({ ok: true });
}));
app.post('/public/unsubscribe', pub, wrap(async (req, res) => {
  const { key, endpoint } = req.body || {};
  const site = key && await get('SELECT id FROM sites WHERE site_key=?', [String(key)]);
  if (site && endpoint) await run('UPDATE subscribers SET active=0 WHERE site_id=? AND endpoint=?', [site.id, String(endpoint)]);
  res.json({ ok: true });
}));
app.post('/public/email-subscribe', pub, wrap(async (req, res) => {
  const { key } = req.body || {};
  const site = key && await get('SELECT id FROM sites WHERE site_key=?', [String(key)]);
  const email = clean(req.body && req.body.email, 254).toLowerCase();
  if (!site || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  await run(`INSERT INTO email_subscribers(site_id,email,source) VALUES(?,?,?)
    ON CONFLICT(site_id,email) DO UPDATE SET active=1, source=excluded.source`,
    [site.id, email, clean(req.body && req.body.source, 100) || 'website-popup']);
  res.json({ ok: true });
}));
app.post('/public/click/:cid', pub, wrap(async (req, res) => {
  await run('UPDATE campaigns SET clicks=clicks+1 WHERE id=?', [req.params.cid]); res.json({ ok: true });
}));

// Embed script: <script src="https://panel/sdk/SITEKEY.js" async></script>
app.get('/sdk/:key.js', cors(), wrap(async (req, res) => {
  const site = await get('SELECT * FROM sites WHERE site_key=?', [req.params.key]);
  if (!site) return res.status(404).type('application/javascript').send('console.error("PushDesk: unknown site key")');
  res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(sdkSource(origin(req), site.site_key, getPublicKey()));
}));
function sdkSource(server, key, vapidPublicKey) {
  return `(function(){
var SERVER=${JSON.stringify(server)},KEY=${JSON.stringify(key)},VAPID=${JSON.stringify(vapidPublicKey)};
var SW=(window.PUSHDESK_SW_PATH||'/pushdesk-sw.js');
var PREVIEW=!!window.PUSHDESK_PREVIEW_PROMPT,DONE='pd_done_'+KEY,EMAIL_DONE='pd_email_done_'+KEY;
var LATER_COUNT='pd_later_count_'+KEY,NEXT_PROMPT='pd_next_prompt_'+KEY;
var previousFocus=null,overlay=null;
function b64(s){var p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
function storageGet(key){try{return localStorage.getItem(key)}catch(e){return null}}
function storageSet(key,value){try{localStorage.setItem(key,String(value))}catch(e){}}
function supported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
function post(path,data){return fetch(SERVER+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(async function(response){if(!response.ok){var result=await response.json().catch(function(){return {}});throw new Error(result.error||'Request failed')}return response.json()})}
async function saveSubscription(sub){
  await post('/public/subscribe',{key:KEY,subscription:sub.toJSON(),page:location.href,language:navigator.language});
  storageSet(DONE,'1');
  return sub;
}
async function subscribe(){
  if(!supported())throw new Error('Push is not supported in this browser');
  var reg=await navigator.serviceWorker.register(SW);await navigator.serviceWorker.ready;
  var perm=await Notification.requestPermission();if(perm!=='granted')throw new Error('Permission '+perm);
  var sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(VAPID)});
  return saveSubscription(sub);
}
async function unsubscribe(){
  var reg=await navigator.serviceWorker.getRegistration(SW);var sub=reg&&await reg.pushManager.getSubscription();if(!sub)return;
  await post('/public/unsubscribe',{key:KEY,endpoint:sub.endpoint});
  await sub.unsubscribe();try{localStorage.removeItem(DONE)}catch(e){}
}
function count(key){var n=Number(storageGet(key)||0);return Number.isFinite(n)?n:0}
function setView(name){
  overlay.querySelector('#pd-push-view').hidden=name!=='push';
  overlay.querySelector('#pd-email-view').hidden=name!=='email';
  overlay.hidden=false;document.body.style.overflow='hidden';
  (name==='push'?overlay.querySelector('#pd-allow'):overlay.querySelector('#pd-email')).focus({preventScroll:true});
}
function close(){if(!overlay)return;overlay.hidden=true;document.body.style.overflow='';if(previousFocus&&previousFocus.focus)previousFocus.focus({preventScroll:true})}
function showEmail(){setView('email')}
function defer(){
  if(overlay&&!overlay.querySelector('#pd-email-view').hidden){
    storageSet(LATER_COUNT,0);storageSet(NEXT_PROMPT,Date.now()+864e5);close();window.setTimeout(banner,864e5);return;
  }
  var amount=count(LATER_COUNT)+1;
  storageSet(LATER_COUNT,amount);
  if(amount>=3){storageSet(NEXT_PROMPT,Date.now()+864e5);close();window.setTimeout(showEmail,2000);window.setTimeout(banner,864e5);return}
  storageSet(NEXT_PROMPT,Date.now()+2000);
  close();
  window.setTimeout(banner,2000);
}
function makePopup(){
  if(overlay)return;
  var link=document.createElement('link');link.rel='stylesheet';link.href=SERVER+'/popup.css';link.dataset.pushdeskPopup='1';document.head.appendChild(link);
  overlay=document.createElement('div');overlay.id='pushdesk-optin';overlay.className='pd-overlay';overlay.hidden=true;
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','pd-title');
  overlay.innerHTML='<section class="pd-card"><button class="pd-close" id="pd-close" type="button" aria-label="Close popup">×</button>'+
    '<div class="pd-view" id="pd-push-view"><div class="pd-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/><path d="M19 3l1.5-1.5M21 7h2"/></svg></div>'+
    '<div class="pd-eyebrow"><span id="pd-site-name"></span> updates</div><h2 id="pd-title">Don\\u2019t Miss What\\u2019s New!</h2><p class="pd-subtitle">Stay updated with the latest news, useful updates and important announcements\\u2014delivered straight to your device.</p>'+
    '<ul class="pd-benefits"><li><span class="pd-check">✓</span><span>Get important updates on time</span></li><li><span class="pd-check">✓</span><span>Be among the first to know what\\u2019s new</span></li><li><span class="pd-check">✓</span><span>Receive updates that matter to you</span></li></ul>'+
    '<button class="pd-primary" id="pd-allow" type="button">🔔 Yes, Keep Me Updated</button><button class="pd-email-option" id="pd-email-option" type="button">Prefer email? Get updates in your inbox</button><button class="pd-later" id="pd-later" type="button">Maybe Later</button>'+
    '<p class="pd-privacy">Your choice matters. You can change notification settings in your browser anytime.</p><p class="pd-status" id="pd-push-status" aria-live="polite"></p></div>'+
    '<div class="pd-view" id="pd-email-view" hidden><div class="pd-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></div>'+
    '<div class="pd-eyebrow">Stay connected</div><h2>Get Updates in Your Inbox</h2><p class="pd-subtitle">Prefer email updates? Sign up to receive this website\\u2019s latest stories and important updates directly in your inbox.</p>'+
    '<form class="pd-form" id="pd-email-form"><label for="pd-email">Email address</label><input id="pd-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required maxlength="254"><button class="pd-primary" type="submit">Subscribe for Updates</button></form>'+
    '<p class="pd-privacy">Your email is saved for this website\\u2019s updates. Email delivery must be configured by the site owner.</p><p class="pd-status" id="pd-email-status" aria-live="polite"></p><button class="pd-later" id="pd-email-later" type="button">Maybe Later</button><button class="pd-back" id="pd-back" type="button">← Back to notification options</button></div></section>';
  document.body.appendChild(overlay);overlay.querySelector('#pd-site-name').textContent=location.hostname;
  overlay.querySelector('#pd-close').onclick=defer;
  overlay.querySelector('#pd-later').onclick=defer;
  overlay.querySelector('#pd-email-option').onclick=showEmail;
  overlay.querySelector('#pd-email-later').onclick=defer;
  overlay.querySelector('#pd-back').onclick=function(){setView('push')};
  overlay.addEventListener('click',function(event){if(event.target===overlay)defer()});
  document.addEventListener('keydown',function(event){if(event.key==='Escape'&&!overlay.hidden)defer()});
  overlay.querySelector('#pd-allow').onclick=async function(){
    var status=overlay.querySelector('#pd-push-status'),button=this;
    button.disabled=true;status.textContent='Connecting…';status.className='pd-status';
    try{await subscribe();status.textContent='You\\u2019re subscribed. Thanks for staying connected!';status.className='pd-status success';window.setTimeout(close,1400)}
    catch(error){status.textContent=error.message==='Permission denied'?'Notifications are blocked in browser settings. Email updates are still available.':'Could not complete the push subscription. Please try again or choose email updates.';status.className='pd-status error';if(!supported()||('Notification' in window&&Notification.permission==='denied'))window.setTimeout(showEmail,1000)}
    finally{button.disabled=false}
  };
  overlay.querySelector('#pd-email-form').onsubmit=async function(event){
    event.preventDefault();
    var input=overlay.querySelector('#pd-email'),status=overlay.querySelector('#pd-email-status'),button=this.querySelector('button[type=submit]');
    status.textContent='Saving your email…';status.className='pd-status';button.disabled=true;
    try{await post('/public/email-subscribe',{key:KEY,email:input.value.trim(),source:'pushdesk-notification-popup'});storageSet(EMAIL_DONE,'1');status.textContent='Thanks! Your email signup has been saved. Email delivery is not configured yet.';status.className='pd-status success';window.setTimeout(close,2400)}
    catch(error){status.textContent=error.message||'Could not save your email. Please try again.';status.className='pd-status error'}
    finally{button.disabled=false}
  };
}
async function checkAndShow(){
  if(window.PUSHDESK_NO_PROMPT||(!PREVIEW&&(storageGet(DONE)==='1'||storageGet(EMAIL_DONE)==='1')))return;
  if(!PREVIEW&&'Notification' in window&&Notification.permission==='granted'){
    try{var reg=await navigator.serviceWorker.getRegistration(SW),sub=reg&&await reg.pushManager.getSubscription();if(sub){await saveSubscription(sub);return}}catch(error){console.error('PushDesk: could not sync existing push subscription',error)}
    if(count(LATER_COUNT)>=3){showEmail();return}
    showEmail();return;
  }
  var amount=count(LATER_COUNT);
  if(!PREVIEW&&amount>=3){showEmail();return}
  var nextAt=Number(storageGet(NEXT_PROMPT)||0);
  if(!PREVIEW&&nextAt>Date.now()){window.setTimeout(banner,nextAt-Date.now());return}
  makePopup();
  previousFocus=document.activeElement;
  setView(PREVIEW||supported()&&Notification.permission!=='denied'?'push':'email');
}
window.PushDesk={subscribe:subscribe,unsubscribe:unsubscribe,supported:supported,showPrompt:function(){makePopup();previousFocus=document.activeElement;setView(PREVIEW||supported()?'push':'email')}};
function banner(){checkAndShow().catch(function(error){console.error('PushDesk popup failed:',error)})}
var promptDelay=PREVIEW?500:4500;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(banner,promptDelay)});else setTimeout(banner,promptDelay);
})();`;
}

// Demo page so you can test end to end on the panel's own origin
app.get('/demo/:key', (req, res) => {
  const key = String(req.params.key).replace(/[^a-z0-9]/gi, '');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PushDesk demo</title><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px">
<h2>PushDesk test page</h2><p>This page previews the push and email popup visitors see on your website. Choose a notification option or subscribe using the button below.</p>
<button id="b" style="padding:10px 18px;font-size:16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;cursor:pointer">Subscribe this browser</button>
<button id="show" style="padding:10px 18px;font-size:16px;border-radius:8px;border:0;background:#eee;color:#111;cursor:pointer">Show popup again</button>
<p id="m" style="color:#555"></p>
<script>window.PUSHDESK_PREVIEW_PROMPT=true</script>
<script src="/sdk/${key}.js?v=${Date.now()}"></script>
<script>document.getElementById('b').onclick=()=>PushDesk.subscribe().then(()=>m.textContent='Subscribed. Send a campaign from the panel.').catch(e=>m.textContent='Error: '+e.message);document.getElementById('show').onclick=()=>PushDesk.showPrompt()</script>`);
});

// ---------- static panel (on Vercel the files in /public are served by the CDN instead) ----------
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`PushDesk running on http://localhost:${port}  (panel: /app)`);
    const dispatchScheduledCampaigns = async () => {
      await ready;
      const due = await all("SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10", [Date.now()]);
      for (const campaign of due) {
        const claimed = await run("UPDATE campaigns SET status='sending' WHERE id=? AND status='scheduled'", [campaign.id]);
        if (!claimed.changes) continue;
        const serverOrigin = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
        sendCampaign(campaign.id, serverOrigin).catch(async (error) => {
          console.error(`Scheduled campaign ${campaign.id} failed:`, error);
          await run("UPDATE campaigns SET status='failed' WHERE id=? AND status='sending'", [campaign.id]);
        }).catch((error) => console.error(`Could not update scheduled campaign ${campaign.id}:`, error));
      }
    };
    const poll = () => dispatchScheduledCampaigns().catch((error) => console.error('Campaign scheduler failed:', error));
    poll();
    setInterval(poll, 5000).unref();
  });
}

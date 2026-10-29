const webpush = require('web-push');
const { all, get, run, ensureSetting } = require('./db');

const SEGMENT_FIELDS = ['browser', 'os', 'device', 'country', 'language'];
let publicKey = null;

async function initPush() {
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    keys = JSON.parse(await ensureSetting('vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
  }
  let subject = (process.env.VAPID_SUBJECT || '').trim();
  if (subject && !/^(mailto:|https:\/\/)/i.test(subject)) subject = subject.includes('@') ? 'mailto:' + subject : '';
  if (!subject) subject = 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
  return publicKey;
}
const getPublicKey = () => publicKey;

function buildAudienceQuery(siteId, segment = {}) {
  let sql = 'FROM subscribers WHERE site_id=? AND active=1';
  const params = [siteId];
  for (const f of SEGMENT_FIELDS) {
    let v = segment[f];
    if (v == null || v === '') continue;
    if (!Array.isArray(v)) v = [v];
    if (!v.length) continue;
    sql += ` AND ${f} IN (${v.map(() => '?').join(',')})`;
    params.push(...v.map(String));
  }
  if (segment.page) { sql += ' AND page LIKE ?'; params.push('%' + String(segment.page) + '%'); }
  return { sql, params };
}

async function countAudience(siteId, segment) {
  const { sql, params } = buildAudienceQuery(siteId, segment);
  return (await get('SELECT COUNT(*) AS n ' + sql, params)).n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithRetry(subscription, payload) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 86400 });
      return;
    } catch (error) {
      const code = error && error.statusCode;
      const networkError = ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT']
        .includes(error && error.code);
      const retryable = code === 429 || (code >= 500 && code < 600) || networkError;
      if (!retryable || attempt === maxAttempts) throw error;

      const retryAfter = error.headers && error.headers['retry-after'];
      const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
      await sleep(Math.min(10000, Math.max(retryAfterMs, 500 * (2 ** (attempt - 1)))));
    }
  }
}

async function sendCampaign(campaignId, serverOrigin) {
  const c = await get('SELECT * FROM campaigns WHERE id=?', [campaignId]);
  if (!c) return;
  let segment = {};
  try { segment = JSON.parse(c.segment || '{}'); } catch (_) {}
  const { sql, params } = buildAudienceQuery(c.site_id, segment);
  const subs = await all('SELECT id, endpoint, p256dh, auth ' + sql, params);
  await run('UPDATE campaigns SET total=? WHERE id=?', [subs.length, c.id]);

  const site = await get('SELECT domain FROM sites WHERE id=?', [c.site_id]);
  const siteDomain = String(site && site.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const favicon = siteDomain ? `https://${siteDomain}/favicon.ico` : '';
  const payload = JSON.stringify({
    title: c.title, body: c.body || '', url: c.url || '', icon: c.icon || favicon, image: c.image || '',
    actionLabel: c.action_label || '', campaignId: c.id, server: serverOrigin
  });
  const CHUNK = 100;
  await run('UPDATE campaigns SET sent=0, failed=0 WHERE id=?', [c.id]);
  let sent = 0, failed = 0;
  const retryQueue = [];
  const isTransient = (error) => {
    const code = error && error.statusCode;
    return code === 429 || (code >= 500 && code < 600) || ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(error && error.code);
  };
  const deliver = async (slice) => {
    const results = await Promise.allSettled(slice.map((s) =>
      sendWithRetry({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
    ));
    const retries = [];
    const deadIds = [];
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') sent++;
      else {
        const reason = r.reason;
        const code = reason && reason.statusCode;
        console.error(`Campaign ${c.id} notification failed for subscriber ${slice[idx].id} (HTTP ${code || 'network error'}):`,
          (reason && reason.message) || reason);
        if (code === 404 || code === 410) deadIds.push(slice[idx].id);
        else if (isTransient(reason)) retries.push(slice[idx]);
        else failed++;
      }
    });
    if (deadIds.length) await run(`UPDATE subscribers SET active=0 WHERE id IN (${deadIds.map(() => '?').join(',')})`, deadIds);
    return retries;
  };
  for (let i = 0; i < subs.length; i += CHUNK) {
    retryQueue.push(...await deliver(subs.slice(i, i + CHUNK)));
    await run('UPDATE campaigns SET sent=?, failed=? WHERE id=?', [sent, failed, c.id]);
  }
  if (retryQueue.length) {
    await sleep(60000);
    const retryResults = await deliver(retryQueue);
    failed += retryResults.length;
    await run('UPDATE campaigns SET sent=?, failed=? WHERE id=?', [sent, failed, c.id]);
  } else {
    await run('UPDATE campaigns SET sent=?, failed=? WHERE id=?', [sent, failed, c.id]);
  }
  await run(`UPDATE campaigns SET status=CASE
    WHEN failed=0 THEN 'completed'
    WHEN sent=0 THEN 'failed'
    ELSE 'completed_with_errors'
    END WHERE id=?`, [c.id]);
}

module.exports = { initPush, getPublicKey, sendCampaign, countAudience, SEGMENT_FIELDS };

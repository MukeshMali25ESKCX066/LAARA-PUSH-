# PushDesk – self-hosted web push notification panel

Unlimited sites, subscribers and campaigns on your own server. Node.js + Express + libSQL (SQLite / Turso) on the backend, a no-build vanilla JS panel on the frontend. Uses the standard Web Push protocol with VAPID keys (no Firebase account needed).

## Run it

```bash
npm install
cp .env.example .env      # set BASE_URL to your public https URL
npm start
```

Open `http://localhost:3000/app`, create your account (first signup), add a site, and follow the **Integration** tab.
After creating your admin account, set `ALLOW_SIGNUP=false` in `.env` to close registration.

Requires Node 18+. With no `TURSO_DATABASE_URL` set it stores data in `data/pushdesk.db`.

## How it works

1. **Integration tab** gives you the embed script `<script src="BASE_URL/sdk/SITEKEY.js" async>` and `pushdesk-sw.js`.
2. Upload `pushdesk-sw.js` to the root of the customer website (service workers must be served from the site's own origin).
3. Visitors see an opt-in prompt; their browser subscription is stored in SQLite (`data/pushdesk.db`) with browser/OS/device/country/language/page.
4. **Send** tab: compose, optionally segment, and send. Campaigns without a custom notification icon use the PushDesk logo. Add a campaign image using a public URL or upload a PNG, JPEG, WebP, or GIF up to 4 MB. Local uploads are stored in `data/uploads/`. Image uploads are unavailable on Vercel; use a public image URL there. Delivery runs in the background in batches of 100; expired subscriptions are deactivated automatically.
5. Clicks are tracked by the service worker and shown per campaign.

Quick local test: **Integration → Open test page** previews the website opt-in popup on `localhost` (allowed as a secure context). Choose **Allow** to subscribe, or select **Show popup again** to preview it again.
With no audience filters selected, a campaign is sent to every active, opted-in subscription for that website. Temporary push-service/network failures are retried; expired subscriptions are deactivated, and campaigns report partial or total delivery failures. Browser permission must be granted and a valid subscription must exist; the push service cannot guarantee that an offline device displays a notification.

The website opt-in popup offers both push notifications and an email signup form. The first two push-prompt **Maybe Later** choices reopen the prompt after two seconds; the third opens the email form. Choosing **Maybe Later** on the email form closes it and restarts the prompt cycle after 24 hours. Successful push or email signup suppresses future prompts on that browser. Email signups are saved per website and can be reviewed or removed from **Subscribers**. PushDesk does not include an email delivery provider, so saving an email address does not send newsletter messages.

To schedule a campaign, select **Schedule this campaign for later** in the campaign builder and choose a time in your local timezone. Scheduled campaigns are stored in the database, checked every five seconds, and can be cancelled from the campaign list. The Node.js server must remain running; scheduled campaigns are not supported by Vercel's serverless deployment.

## REST API

```bash
curl -X POST $BASE_URL/api/v1/send -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"Post is live","url":"https://example.com","segment":{"device":["Mobile"]}}'
GET /api/v1/subscribers/count?country=IN
GET /api/v1/campaigns/:id
```

## Production notes

- Serve behind HTTPS (nginx/Caddy). Web Push does not work on plain http except localhost.
- Keep `data/` backed up. It holds subscribers, uploaded campaign images, and your VAPID keys. **If you lose the VAPID keys, all existing subscribers stop working.**
- Country detection reads `cf-ipcountry` (Cloudflare) or `x-vercel-ip-country`; otherwise it shows `Unknown`. Add a GeoIP lookup in `server/index.js` (`/public/subscribe`) if you need it.
- iOS: Safari only supports push for sites added to the Home Screen (iOS 16.4+).
- Run with PM2 or systemd: `pm2 start server/index.js --name pushdesk`.

## Not included

WordPress plugin, scheduled/automatic sends (AutoMagic, YouTube push, push-on-publish), Google Drive backup, and subscriber import tools. The REST API is enough to build push-on-publish yourself.


## Deploy on Vercel (with Turso database)

1. Create a free database at https://turso.tech, then copy its **URL** (`libsql://...`) and create an **auth token**.
2. Push this folder to GitHub. If it lives in a subfolder, set **Root Directory** to that folder in Vercel.
3. Vercel -> Add New Project -> import the repo. Framework: **Other**. Leave build settings empty.
4. Set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BASE_URL` (your final https URL), and `VAPID_SUBJECT`. Campaign images on Vercel must use a public image URL; direct file uploads are supported only when running the Node.js server with persistent disk storage.
5. Deploy, open `https://YOUR-PROJECT.vercel.app/app`, create the admin account, then set `ALLOW_SIGNUP=false` and redeploy.

Notes: VAPID keys are generated once and stored in the database, so redeploys never break existing subscribers. Campaigns keep sending after the response using `waitUntil`; the function limit is 60 seconds on the free plan, which is fine for small and medium lists. Vercel's serverless filesystem is not persistent, so upload campaign images to another public image host and paste the URL. For very large lists use a VPS instead.


## Dashboard
The responsive orange-and-white dashboard brings together account-wide subscriber and campaign metrics, recent activity, browser and operating-system breakdowns, and website shortcuts. The sidebar links to website management, campaign sending and history, subscribers, integration, templates, analytics, and API access. These screens use the existing authenticated API.

Recurring automation, billing, and team management are not implemented in this codebase; they need backend endpoints and database support before they can be offered as working dashboard features.

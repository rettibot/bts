# RATCHOPPER BTS EP Release

Simple static landing page with Netlify Functions handling payments, access tokens, and downloads for the BTS EP drops.

## Architecture
- Frontend: static site served from `index.html` plus assets in `assets/`. No build step.
- Serverless backend (Netlify Functions in `netlify/functions`):
  - Payments: `create-checkout-session.js` (Stripe), `create-nowpayments-invoice.js` and `nowpayments-webhook.js` (crypto), `create-flouci-payment.js` (Tunisia).
  - Access + backup: `generate-token.js` verifies payments, stores purchase info in Airtable, sends backup email via Resend; `use-backup.js` issues a 24h rescue token; `verify-token.js` checks JWT tokens and remaining downloads.
  - Downloads: `download.js` enforces download limits, generates short-lived Backblaze B2 links.
  - Reservations: `handle-reservation.js` creates Tunisian waitlist/reservations and emails users.
- Data/services: Airtable (purchases + reservations), Stripe/NOWPayments/Flouci (payments), Backblaze B2 (files), Resend (email), JWT tokens for gated access.
- Hosting: Netlify. `netlify.toml` routes `dev.ratchoppermusic.com` to the dev preview.

## Branches / Environments
- `main` → production at `https://bts.ratchoppermusic.com` (latest approved prod build; current HEAD not yet deployed).
- `dev` → staging at `https://dev.ratchoppermusic.com` (work-in-progress).
- `bts-tn` → Tunisian production at `https://bts-tn.ratchoppermusic.com`; uses the Tunisian payment flow (Flouci) and reservation logic tailored to that market.

## Run Locally (non‑technical friendly)
These steps work on Windows, macOS, or Linux. You only need basic copy/paste.

### 1) Install the tools
- Install Node.js 18+ from https://nodejs.org (include “npm”).
- Install Git from https://git-scm.com (Windows: choose “Git from the command line” during setup).
- Optional but recommended: Netlify CLI `npm install -g netlify-cli` (lets you run functions locally).

### 2) Get the code
Open **Terminal** (macOS/Linux) or **PowerShell** (Windows) and run:
```bash
git clone https://github.com/REPO_OWNER/bts-ep-release-official.git
cd bts-ep-release-official
npm install
```
Replace `REPO_OWNER` with the actual org/user if the URL differs.

### 3) Add your environment variables
Create a `.env` file in the project root with your real keys (get them from the Netlify dashboard or the team). Example (leave values blank until you have them):
```
SITE_URL=https://bts.ratchoppermusic.com
STRIPE_SECRET_KEY=
NOWPAYMENTS_API_KEY=
FLOUCI_APP_TOKEN=
FLOUCI_APP_SECRET=
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE_NAME=
RESEND_API_KEY=
JWT_SECRET=
B2_ENDPOINT=
B2_KEY_ID=
B2_APPLICATION_KEY=
B2_BUCKET_NAME=
UNTITLED_STREAM_URL=
```
Save the file; the app will read it automatically when running locally.

### 4) Start the site + functions
- If you installed Netlify CLI: `netlify dev`
  - Opens http://localhost:8888 and proxies all `/.netlify/functions/*` calls.
- If you do **not** use Netlify CLI: open `index.html` in your browser for static content, but API calls will fail without the CLI proxy, so prefer `netlify dev`.

### 5) Preview branches
To test a branch locally, switch then run:
```bash
git checkout dev       # or main / bts-tn
netlify dev
```

## Notes for contributors
- Keep production changes on `main`; use `dev` for experiments, `bts-tn` for Tunisian-specific updates.
- Serverless code lives in `netlify/functions/`; static assets sit at the repo root.
- Avoid committing real secrets—use `.env` locally and Netlify environment variables in the dashboard.


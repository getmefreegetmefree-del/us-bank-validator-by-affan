# US Bank Validator by Affan

A standalone web app for checking US bank details you enter by hand: routing number, account number and account type. It tells you clearly **what was verified and what was not**.

**Live (browser-only mode):** https://getmefreegetmefree-del.github.io/us-bank-validator-by-affan/

| Check | How it's done | Needs |
|---|---|---|
| Routing number format | Exactly 9 digits | Nothing (runs in the browser) |
| ABA checksum | Official `3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 mod 10` | Nothing |
| Routing prefix / Fed district | Valid prefixes 00–12, 21–32, 61–72, 80 | Nothing |
| Bank profile (name, main office/branch, phones by department, office + mailing address, homepage, branches, Lyons ID, routing numbers) | Lyons Commercial Data RTN API (same data as iBankRegistry), FedACH file, or Increase | Backend + data source |
| ACH / Wire / RTP / FedNow | FedACH RDFI listing, Lyons routing records and tags, or Increase | Backend + data source |
| Account number format | Digits only, 4–17 characters (NACHA field limit), sanity checks | Nothing |
| Institution-specific length | Only from rules **you** add, with a cited source | Backend + `data/institution-rules.json` |
| Account status (open / closed / invalid / not found) | Lyons AOA or Socure Account Intelligence | Backend + Lyons or Socure credentials |

The app **never** guesses an account's status from its length or format. If no provider is connected, the result says *"Not verified: no provider connected"* in yellow.

Colors: **green** = verified, **red** = invalid / failed, **yellow** = uncertain or not checked.

---

## Two ways to run it

### 1. Browser-only (what GitHub Pages hosts)

GitHub Pages serves static files only, so the live link runs the checks that need no server or secrets: format, ABA checksum, prefix, and account-number format. Bank identification, ACH eligibility and account verification show as **not checked**, with a link to the Federal Reserve's official lookup page.

### 2. Full mode (Node.js backend)

The backend keeps API credentials secret and runs the directory and provider lookups.

```bash
git clone https://github.com/getmefreegetmefree-del/us-bank-validator-by-affan.git
cd us-bank-validator-by-affan
npm install
cp .env.example .env      # then fill in what you have
npm start                 # → http://localhost:3000
npm test                  # 26 tests
```

Requires Node.js 18.17 or newer. On startup, the server prints which sources are connected.

---

## API credentials and data sources

Everything is optional. Add what you have, and the UI adapts and labels each result by its source.

### A. Routing directory (bank profile + ACH eligibility)

**Option 1: Lyons Commercial Data (best: the same data you see in iBankRegistry)**

- `LYONS_COMPANY_ID`, `LYONS_USERNAME`, `LYONS_PASSWORD`: **web-services** credentials issued by Lyons. An iBankRegistry website login is not automatically an API login. Ask Lyons support whether your plan includes the **RTN 2.1** and **AOA** web services.
- Uses `POST …/rtn2.1/RTNServiceWCF.svc/rest/GetPrimaryInstitutionDetails` (docs: https://apihelp.lyonsreg.com/). Sessions are cached and renewed automatically.
- Shows a registry-style profile: name, main office or branch, Customer Service / Wire / Adjust / Return / Institution / ACH Dept phones, fax, office and mailing address, homepage, Lyons ID, branch count, institution type, every routing number with its purpose, and Wire / RTP / FedNow flags.

**Option 2: Federal Reserve FedACH Participant Directory (authoritative for ACH)**

- No API key needed. You need the data file `FedACHdir.txt` (fixed-width) or a JSON export.
- Since December 2018 the Fed publishes the full file only to institutions with a **FedLine** connection. Non-banks can usually get it from **the bank that processes their ACH payments** (ask for an "E-Payments Routing Directory download code"). Single numbers can be checked by hand at the [Fed's FedACH participant search](https://www.frbservices.org/resources/e-payments-routing-directory/search-fedach-participant-rdfis/).
- Put the file at `data/FedACHdir.txt`, or set `FEDACH_DIRECTORY_PATH`. It's git-ignored, because the Fed's terms prohibit redistributing it.
- Update it regularly. The Fed refreshes the directory daily.

**Option 3: Increase routing-number API**

- `INCREASE_API_KEY`: create one at https://dashboard.increase.com/developers/api_keys (requires an Increase account).
- `INCREASE_ENVIRONMENT=production`: the lookup is read-only (`GET /routing_numbers`). Sandbox recognizes only a few test numbers.
- Returns the institution name and whether it supports ACH, wire, RTP and FedNow.

Any combination works. The profile comes from the first source that knows the number (Lyons → FedACH → Increase). ACH eligibility comes from the FedACH file when it's loaded, because that file *is* the Fed's participant list.

### B. Real account verification

**Lyons AOA**, set `ACCOUNT_VERIFICATION_PROVIDER=lyons` (uses the same Lyons credentials):

| Lyons code | Shown as |
|---|---|
| 101 Accept | 🟢 Open / verified |
| 103, 104 Deny | 🔴 Possibly closed / negative account data |
| 198 No account experience | 🔴 Account not found |
| 199 Insufficient info | 🟡 Unable to verify |
| −30/−31/−33, −20/−22 | 🔴 Invalid account / routing number |
| Other errors | 🟡 Unable to verify |

Lyons requires an inquiry amount (`LYONS_AOA_AMOUNT`, default 1.00). It's part of the status inquiry only; nothing is charged or moved.

**Socure Account Intelligence (RiskOS)**, set `ACCOUNT_VERIFICATION_PROVIDER=socure`:

| Variable | What it is |
|---|---|
| `SOCURE_API_KEY` | RiskOS API key (Bearer token) from your Socure account |
| `SOCURE_ENVIRONMENT` | `sandbox` or `production` |
| `SOCURE_WORKFLOW` | Name of your RiskOS workflow that includes the Account Intelligence enrichment (default `bank_account_validation`) |
| `SOCURE_OPEN_MIN_SCORE` / `SOCURE_CLOSED_MAX_SCORE` | Score cut-offs copied from **your** RiskOS scoring guide |
| `SOCURE_*_REASON_CODES` | Reason codes that mean closed / invalid / not found, also from your dashboard |

The app sends an `AVAILABILITY` inquiry (routing + account number) to `POST /api/evaluation`. That's a database lookup: no money moves and no ACH entry is created. Socure returns an **availability score** (0–1) and reason codes. Their meanings are published only inside each customer's dashboard, so until you set the thresholds and codes, the app shows the raw score as **"Unable to verify"** instead of inventing a status.

**Adding another provider** (GIACT gVerify, Early Warning, your bank's own account-validation API, etc.): create a module in `server/accounts/` exporting `configured(env)` and `verify(input, env)`, register it in `server/accounts/index.js`, and map its responses to `open_verified | possibly_closed | invalid | not_found | unable_to_verify`.

---

## Deploying the full app

### Backend on Render (free tier works)

1. In Render, choose **New → Blueprint**, then pick this repo. `render.yaml` is included.
2. Fill in the secret env vars (`LYONS_COMPANY_ID` / `LYONS_USERNAME` / `LYONS_PASSWORD`, and set `ACCOUNT_VERIFICATION_PROVIDER=lyons`).
3. Make sure `ALLOWED_ORIGINS` includes `https://getmefreegetmefree-del.github.io`.

Any Node host works (Railway, Fly.io, a VPS). Run `npm start` with the env vars set.

### Point the GitHub Pages site at the backend

Repo **Settings → Secrets and variables → Actions → Variables → New variable**:
`API_BASE` = `https://<your-backend>.onrender.com`. Then re-run the **Deploy frontend to GitHub Pages** workflow. The live site switches from "Basic mode" to "Server connected".

Note: a FedACH file can't be uploaded to Render's free tier through git, since it's git-ignored. Use Increase there, or a host with persistent storage, and set `FEDACH_DIRECTORY_PATH`.

---

## Privacy and safety

- Bank details are processed **in memory only**: never written to disk, a database or logs.
- API responses carry `Cache-Control: no-store`. The full account number is never returned. Results show only the last 4 digits.
- The account field is hidden while typing, and the form has autocomplete turned off.
- Credentials live only in server env vars and are never sent to the browser.
- No transactions, micro-deposits, prenotes or withdrawals are ever started.
- Security headers (CSP, frame-deny, no-referrer), a 2 KB request limit, and per-IP rate limiting.
- Malformed input is never forwarded to a paid provider.

## Project structure

```
public/            static frontend (also deployed to GitHub Pages)
  js/validation.js shared validation logic (browser + server)
  js/app.js        UI
server/
  index.js         Express app, /api/health, /api/verify
  verify.js        orchestration + "what was / wasn't verified" summary
  lyons.js         Lyons RTN + AOA client
  routing/         FedACH file loader, Increase client, source merging
  accounts/        provider registry (Lyons, Socure)
data/              optional FedACH file and institution rules (git-ignored)
test/              node:test suites
```

## License

MIT, © Affan

/**
 * US Bank Validator by Affan — backend server.
 *
 * - Serves the static frontend from /public
 * - POST /api/verify   runs validation + configured lookups
 * - GET  /api/health   reports which data sources / providers are connected (no secrets)
 *
 * Privacy: request bodies are never logged or persisted. Responses carry
 * Cache-Control: no-store. Account numbers are masked in every response.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFedAchDirectory } from './routing/fedachDirectory.js';
import { routingSourcesSummary } from './routing/index.js';
import { activeProvider } from './accounts/index.js';
import { loadInstitutionRules, institutionRulesMeta } from './institutionRules.js';
import { validateInput, runVerification } from './verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

export function createApp(env = process.env) {
  loadFedAchDirectory({ explicitPath: env.FEDACH_DIRECTORY_PATH, dataDir: DATA_DIR });
  loadInstitutionRules(DATA_DIR);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });

  // CORS: only for origins you list (e.g. your GitHub Pages site).
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Minimal in-memory rate limiter (counts per IP only — no bank data kept).
  const WINDOW_MS = 60_000;
  const MAX_REQ = Number(env.RATE_LIMIT_PER_MINUTE || 30);
  const hits = new Map();
  setInterval(() => hits.clear(), WINDOW_MS).unref();
  const rateLimit = (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > MAX_REQ) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    next();
  };

  app.use(express.json({ limit: '2kb' }));

  app.get('/api/health', (req, res) => {
    const provider = activeProvider(env);
    res.json({
      ok: true,
      app: 'US Bank Validator by Affan',
      routingSources: routingSourcesSummary(env),
      accountVerification: {
        provider: provider.key === 'none' ? null : provider.label,
        ready: provider.ready,
      },
      institutionRules: institutionRulesMeta(),
    });
  });

  app.post('/api/verify', rateLimit, async (req, res) => {
    const { errors, input } = validateInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    try {
      const result = await runVerification(input, env);
      res.json(result);
    } catch (err) {
      // Log the error type only, never the request body.
      console.error('verify failed:', err?.name || 'Error', err?.message ? '(message suppressed)' : '');
      res.status(500).json({ error: 'Verification failed unexpectedly. No result was generated.' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  // Malformed JSON etc.
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid request body.' });
    }
    res.status(500).json({ error: 'Server error.' });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    const s = routingSourcesSummary();
    const p = activeProvider();
    console.log(`US Bank Validator by Affan running on http://localhost:${port}`);
    console.log(`  FedACH directory: ${s.fedachDirectory.configured ? `${s.fedachDirectory.records} records` : 'not loaded'}`);
    console.log(`  Increase routing API: ${s.increase.configured ? 'configured' : 'not configured'}`);
    console.log(`  Account verification: ${p.key === 'none' ? 'none (format checks only)' : `${p.label} (${p.ready ? 'ready' : 'missing credentials'})`}`);
  });
}

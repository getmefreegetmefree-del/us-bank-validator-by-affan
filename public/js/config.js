/*
 * Frontend configuration.
 *
 * apiBase: where the backend lives.
 *   ""                                  → same origin (when the Node server serves this page)
 *   "https://your-backend.onrender.com" → a separately hosted backend (e.g. for GitHub Pages)
 *
 * When no backend answers, the app runs in BASIC MODE: browser-only checks
 * (format + ABA checksum). It never pretends to have verified anything else.
 */
window.APP_CONFIG = {
  apiBase: "",
};

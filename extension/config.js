// Point this at your deployed worker when you host it. For local dev, keep
// the dev server running (node scripts/dev-server.mjs) and this just works.
const API_BASE = 'http://localhost:8787';

// Exposed to the side panel so it can show where reports are going.
globalThis.FLR_CONFIG = { API_BASE };

// Local dev runner: serves the Cloudflare Worker in plain Node (no wrangler).
// Implements just enough of a D1-compatible SQL shim (backed by a JSON file)
// and an in-memory KV to exercise the real worker code end-to-end.
//
//   node scripts/dev-server.mjs            # http://localhost:8787
//   PORT=9000 node scripts/dev-server.mjs

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, '.data');
const DB_FILE = join(DATA_DIR, 'dev-db.json');

await mkdir(DATA_DIR, { recursive: true });

let state = { reports: [], profiles: {}, nextId: 1 };
if (existsSync(DB_FILE)) {
  try {
    state = JSON.parse(await readFile(DB_FILE, 'utf8'));
  } catch (e) {
    console.warn('Could not parse dev DB, starting fresh:', e.message);
  }
}

async function persist() {
  await writeFile(DB_FILE, JSON.stringify(state, null, 2));
}

// --- Tiny D1-compatible shim ------------------------------------------------
function makeStatement(sql, params = []) {
  const norm = sql.replace(/\s+/g, ' ').trim();
  return {
    bind(...args) {
      return makeStatement(sql, args);
    },
    async first() {
      if (/SELECT COUNT\(\*\) AS n FROM reports/i.test(norm)) {
        return { n: state.reports.length };
      }
      if (/SELECT COUNT\(DISTINCT profile_url\) AS n FROM profiles/i.test(norm)) {
        return { n: Object.keys(state.profiles).length };
      }
      const p = state.profiles[params[0]];
      return p ? { ...p } : null;
    },
    async all() {
      if (/FROM profiles p JOIN reports r/i.test(norm)) {
        return { results: leaderboardRows(params[0]) };
      }
      if (/FROM reports WHERE profile_url = \?/i.test(norm)) {
        const url = params[0];
        const rows = state.reports
          .filter((r) => r.profile_url === url)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 50)
          .map((r) => ({ score: r.score, level: r.level, reasons_json: r.reasons_json, created_at: r.created_at }));
        return { results: rows };
      }
      return { results: [] };
    },
    _sql: norm,
    _params: params,
  };
}

function leaderboardRows(limit = 100) {
  const byUrl = new Map();
  for (const r of state.reports) {
    const cur = byUrl.get(r.profile_url) || { scores: [], last: 0 };
    cur.scores.push(r.score);
    cur.last = Math.max(cur.last, r.created_at);
    byUrl.set(r.profile_url, cur);
  }
  const rows = [...byUrl.entries()].map(([url, { scores, last }]) => {
    const p = state.profiles[url] || {};
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    return {
      profile_url: url,
      handle: p.handle || url.split('/').pop(),
      name: p.name || '',
      headline: p.headline || '',
      photo_url: p.photo_url || '',
      reports: scores.length,
      avg_score: avg,
      last_reported: last,
    };
  });
  rows.sort((a, b) => b.reports - a.reports || b.avg_score - a.avg_score || b.last_reported - a.last_reported);
  return rows.slice(0, limit);
}

const db = {
  prepare(sql) {
    return makeStatement(sql);
  },
  async batch(stmts) {
    for (const s of stmts) {
      const sql = s._sql;
      const p = s._params;
      if (/INSERT INTO reports/i.test(sql)) {
        state.reports.push({
          id: state.nextId++,
          profile_url: p[0],
          ip_hash: p[1],
          score: p[2],
          level: p[3],
          reasons_json: p[4],
          profile_json: p[5],
          created_at: p[6],
        });
      } else if (/INSERT INTO profiles/i.test(sql)) {
        const [url, handle, name, headline, photoUrl, firstSeen, lastReported] = p;
        const prev = state.profiles[url] || {};
        state.profiles[url] = {
          profile_url: url,
          handle,
          name: name || prev.name || '',
          headline: headline || prev.headline || '',
          photo_url: photoUrl || prev.photo_url || '',
          first_seen: prev.first_seen || firstSeen,
          last_reported: lastReported,
        };
      }
    }
    await persist();
    return [];
  },
};

// In-memory KV with simple TTL ignored (cooldown logic reads timestamps itself)
const kvMem = new Map();
const RATE_KV = {
  async get(k) {
    return kvMem.has(k) ? kvMem.get(k) : null;
  },
  async put(k, v) {
    kvMem.set(k, v);
  },
};

const env = {
  DB: db,
  RATE_KV,
  IP_SALT: process.env.IP_SALT || 'dev-salt',
};

const { default: worker } = await import(pathToFileURL(join(ROOT, 'src/worker.js')).href);

async function toRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  // In dev, allow X-Forwarded-For to simulate different reporters.
  const spoof = headers.get('x-forwarded-for');
  if (!headers.has('cf-connecting-ip') || spoof) headers.set('cf-connecting-ip', spoof || '127.0.0.1');
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

const server = http.createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'dev_server_error', message: err.message }));
  }
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log(`\n  Fake LinkedIn — local dev`);
  console.log(`  Leaderboard : http://localhost:${PORT}/`);
  console.log(`  API health  : http://localhost:${PORT}/api/health`);
  console.log(`  DB file     : ${DB_FILE}\n`);
});

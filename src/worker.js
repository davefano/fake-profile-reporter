import { gradeProfile } from '../shared/grader.js';
import { normalizeProfileUrl } from '../shared/url.js';
import { hashIp } from './ip.js';
import { createD1Store } from './store-d1.js';
import { leaderboardHtml } from '../public/leaderboard-template.js';

const REPORT_COOLDOWN_MS = 1000 * 60 * 60 * 6; // 6h per IP per profile
const DAILY_LIMIT = 50; // reports per IP per day

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

// Minimal in-memory KV fallback for local dev when env.REPORTS isn't a real KV.
function memoryKv() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    try {
      if (url.pathname === '/api/report' && request.method === 'POST') {
        return await handleReport(request, env);
      }
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
        return await handleLeaderboard(url, env);
      }
      if (url.pathname === '/api/profile' && request.method === 'GET') {
        return await handleProfile(url, env);
      }
      if (url.pathname === '/api/health') {
        return json({ ok: true });
      }
      if (url.pathname === '/' || url.pathname === '/leaderboard') {
        return new Response(leaderboardHtml(), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    } catch (err) {
      return json({ error: 'internal_error', message: String(err && err.message || err) }, 500);
    }

    return json({ error: 'not_found' }, 404);
  },
};

function getStore(env) {
  if (env.DB && typeof env.DB.prepare === 'function') return createD1Store(env.DB);
  throw new Error('D1 binding DB is required');
}

function getKv(env) {
  return env.RATE_KV && typeof env.RATE_KV.get === 'function' ? env.RATE_KV : env.__memKv || (env.__memKv = memoryKv());
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

async function handleReport(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'bad_json' }, 400);

  const norm = normalizeProfileUrl(body.url || body.profileUrl);
  if (!norm) return json({ error: 'invalid_profile_url' }, 400);

  const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};
  const grader = gradeProfile(profile);

  const ipHash = await hashIp(clientIp(request), env.IP_SALT || 'dev-salt');
  const kv = getKv(env);
  const now = Date.now();

  const cooldownKey = `cd:${norm.url}:${ipHash}`;
  const last = await kv.get(cooldownKey);
  if (last && now - Number(last) < REPORT_COOLDOWN_MS) {
    return json({ error: 'already_reported_recently', retryAfterMs: REPORT_COOLDOWN_MS - (now - Number(last)) }, 429);
  }

  const dayKey = `day:${ipHash}:${new Date(now).toISOString().slice(0, 10)}`;
  const count = Number((await kv.get(dayKey)) || 0);
  if (count >= DAILY_LIMIT) return json({ error: 'daily_limit_reached' }, 429);

  await getStore(env).addReport({
    url: norm.url,
    handle: norm.handle,
    grader,
    profile,
    ipHash,
    createdAt: now,
  });

  await kv.put(cooldownKey, String(now));
  await kv.put(dayKey, String(count + 1));

  return json({ ok: true, url: norm.url, handle: norm.handle, grader }, 201);
}

async function handleLeaderboard(url, env) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
  const rows = await getStore(env).listLeaderboard({ limit });
  const stats = await getStore(env).stats();
  return json({
    stats,
    rows: rows.map((r) => ({
      url: r.profile_url,
      handle: r.handle,
      name: r.name,
      headline: r.headline,
      photoUrl: r.photo_url,
      reports: Number(r.reports),
      avgScore: Number(r.avg_score),
      lastReported: Number(r.last_reported),
    })),
  });
}

async function handleProfile(url, env) {
  const norm = normalizeProfileUrl(url.searchParams.get('url'));
  if (!norm) return json({ error: 'invalid_profile_url' }, 400);
  const data = await getStore(env).getProfile(norm.url);
  if (!data) return json({ error: 'not_found' }, 404);
  return json({
    url: data.profile.profile_url,
    handle: data.profile.handle,
    name: data.profile.name,
    headline: data.profile.headline,
    photoUrl: data.profile.photo_url,
    reports: data.reports.map((r) => ({
      score: Number(r.score),
      level: r.level,
      reasons: safeJson(r.reasons_json, []),
      createdAt: Number(r.created_at),
    })),
  });
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

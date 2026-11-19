import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { gradeProfile, normalizeProfileUrl } from '@flr/core';
import type { LeaderboardResponse, ProfileObservation } from '@flr/core';
import type { Env } from './env';
import { clientIp, hashIp } from './ip';
import { createD1Store } from './store';
import { leaderboardHtml } from './leaderboard-page';
import { accounts } from './accounts';
import { entities } from './entities';

const REPORT_COOLDOWN_MS = 1000 * 60 * 60 * 6; // 6h per IP per profile
const DAILY_LIMIT = 50; // reports per IP per day

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type'] }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/', accounts);
app.route('/', entities);

app.post('/api/report', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'bad_json' }, 400);

  const norm = normalizeProfileUrl(body.url ?? body.profileUrl);
  if (!norm) return c.json({ error: 'invalid_profile_url' }, 400);

  const profile = (body.profile && typeof body.profile === 'object' ? body.profile : {}) as ProfileObservation;
  const grader = gradeProfile(profile);

  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  const kv = c.env.RATE_KV;
  const now = Date.now();

  const cooldownKey = `cd:${norm.url}:${ipHash}`;
  const last = await kv.get(cooldownKey);
  if (last && now - Number(last) < REPORT_COOLDOWN_MS) {
    return c.json({ error: 'already_reported_recently', retryAfterMs: REPORT_COOLDOWN_MS - (now - Number(last)) }, 429);
  }

  const dayKey = `day:${ipHash}:${new Date(now).toISOString().slice(0, 10)}`;
  const count = Number((await kv.get(dayKey)) || 0);
  if (count >= DAILY_LIMIT) return c.json({ error: 'daily_limit_reached' }, 429);

  await createD1Store(c.env.DB).addReport({
    url: norm.url,
    handle: norm.handle,
    grader,
    profile,
    ipHash,
    createdAt: now,
  });

  await kv.put(cooldownKey, String(now), { expirationTtl: REPORT_COOLDOWN_MS / 1000 });
  await kv.put(dayKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });

  return c.json({ ok: true, url: norm.url, handle: norm.handle, grader }, 201);
});

app.get('/api/leaderboard', async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 200);
  const store = createD1Store(c.env.DB);
  const [rows, stats] = await Promise.all([store.listLeaderboard({ limit }), store.stats()]);
  const res: LeaderboardResponse = {
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
  };
  return c.json(res);
});

app.get('/api/profile', async (c) => {
  const norm = normalizeProfileUrl(c.req.query('url'));
  if (!norm) return c.json({ error: 'invalid_profile_url' }, 400);
  const data = await createD1Store(c.env.DB).getProfile(norm.url);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({
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
});

app.get('/', (c) => c.html(leaderboardHtml()));
app.get('/leaderboard', (c) => c.html(leaderboardHtml()));

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export default app;

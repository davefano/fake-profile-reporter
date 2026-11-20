import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { leaderboardHtml } from './leaderboard-page';
import { accounts } from './accounts';
import { entities } from './entities';

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

app.get('/', (c) => c.html(leaderboardHtml()));
app.get('/leaderboard', (c) => c.html(leaderboardHtml()));

export default app;

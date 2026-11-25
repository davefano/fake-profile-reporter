import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { accounts } from './accounts';
import { entities } from './entities';
import { removals, retention } from './removals';
import { reports } from './reports';
import { EXTENSION_ORIGIN, verify } from './verify';

const app = new Hono<{ Bindings: Env }>();

// Only the extension may call the API from a browser; web pages get no CORS
// headers. (This stops other sites' scripts, not scripts outside a browser.)
// Admin routes get none at all: they're for the maintainer's own scripts.
const extensionCors = cors({ origin: (o) => (EXTENSION_ORIGIN.test(o) ? o : null), allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['content-type', 'x-reporter-key'] });
app.use('/api/*', (c, next) => (/^\/api\/admin(\/|$)/.test(c.req.path) ? next() : extensionCors(c, next)));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/', accounts);
app.route('/', entities);
app.route('/', reports);
app.route('/', removals);
app.route('/', verify);

// The daily cron trigger (wrangler.toml) runs the retention deletes.
export default Object.assign(app, {
  scheduled: async (controller: ScheduledController, env: Env, _ctx: ExecutionContext) => retention(env.DB, controller.scheduledTime),
});

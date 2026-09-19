/**
 * ryuxik.io Worker — static site + Selects private client galleries.
 *
 * Every path OUTSIDE wrangler.jsonc's run_worker_first globs is served from
 * ./dist by Workers Assets exactly as before this Worker existed; the code
 * below only ever sees /g/*, /api/*, and /admin*. SPEC.md § Client galleries
 * is the contract; worker/routes/* implement it. The one public-site route is
 * POST /api/e, the first-party funnel beacon (SPEC.md § Site analytics).
 */

import { handleGallery } from './routes/gallery';
import { handleAdmin } from './routes/admin';
import { handleTrack } from './routes/track';
import { runCron } from './cron';
import { notFoundTombstone } from './lib/html';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);

    try {
      if (path[0] === 'g') return await handleGallery(request, env, path);
      if (path[0] === 'api' && path[1] === 'e' && path.length === 2) return await handleTrack(request, env, ctx);
      if (path[0] === 'admin' || (path[0] === 'api' && path[1] === 'admin'))
        return await handleAdmin(request, env, path);
    } catch (error) {
      console.log('worker error:', (error as Error).stack ?? String(error));
      return new Response('Something went wrong on our side.', { status: 500 });
    }

    // A run_worker_first path nothing claimed (e.g. bare /api/) — same
    // tombstone as an unknown gallery for /g, plain 404 otherwise.
    if (path[0] === 'g') return notFoundTombstone();
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

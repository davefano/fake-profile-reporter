// Background: the toolbar toggle, and routing for the scam-check feature.

import type { LeaderboardResponse } from '@flr/core/wire';
import { api } from '@/lib/api';
import { serve } from '@/lib/runtime';
import { getSettings, serverBase } from '@/lib/saves/settings';
import { uploadPending } from '@/lib/saves/upload';
import type { AppMessages } from '@/lib/scan/messages';
import { scan } from '@/lib/scan/scan';
import { submit } from '@/lib/scan/submit';
import { setUpToolbarToggle } from '@/lib/toolbar';

const NO_SERVER = { error: 'no_server', message: 'Saves stay in this browser. Pick a server in Settings to see reports.' };

// Non-persistent on MV2 (Firefox/Safari) to match the Chrome service worker.
export default defineBackground({
  persistent: false,
  main() {
    setUpToolbarToggle();
    serve<AppMessages>({
      FLR_SCAN: (msg) => scan(!!msg.force),
      FLR_SUBMIT: (msg) => submit(msg.key, msg.report),
      FLR_LEADERBOARD: async () => {
        const base = serverBase(await getSettings());
        return base ? api<LeaderboardResponse>(base, 'GET', '/api/leaderboard?limit=50') : NO_SERVER;
      },
      FLR_UPLOAD: async () => {
        const base = serverBase(await getSettings());
        return base ? uploadPending(base) : NO_SERVER;
      },
    });
  },
});

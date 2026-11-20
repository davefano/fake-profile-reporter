// Background: the toolbar toggle, and routing for the scam-check feature.

import type { LeaderboardResponse } from '@flr/core';
import { api } from '@/lib/api';
import { serve } from '@/lib/runtime';
import type { AppMessages } from '@/lib/scan/messages';
import { scan } from '@/lib/scan/scan';
import { submit } from '@/lib/scan/submit';
import { setUpToolbarToggle } from '@/lib/toolbar';

// Non-persistent on MV2 (Firefox/Safari) to match the Chrome service worker.
export default defineBackground({
  persistent: false,
  main() {
    setUpToolbarToggle();
    serve<AppMessages>({
      FLR_SCAN: (msg) => scan(!!msg.force),
      FLR_SUBMIT: (msg) => submit(msg.key, msg.report),
      FLR_LEADERBOARD: () => api<LeaderboardResponse>('GET', '/api/leaderboard?limit=50'),
    });
  },
});

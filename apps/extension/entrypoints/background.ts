// Background: the toolbar toggle, and routing for the scam-check feature.

import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import type { AppRequest } from '@/lib/messages';
import { serve } from '@/lib/runtime';
import { scan } from '@/lib/scan/scan';
import { submit } from '@/lib/scan/submit';
import { setUpToolbarToggle } from '@/lib/toolbar';

// Non-persistent on MV2 (Firefox/Safari) to match the Chrome service worker.
export default defineBackground({
  persistent: false,
  main() {
    setUpToolbarToggle();
    serve<AppRequest>((msg) => {
      switch (msg.type) {
        case 'FLR_SCAN':
          return scan(!!msg.force);
        case 'FLR_SUBMIT':
          return submit(msg.key, msg.report);
        case 'FLR_LEADERBOARD':
          return api('GET', '/api/leaderboard?limit=50');
        case 'FLR_CONFIG':
          return Promise.resolve({ API_BASE });
        default:
          return undefined;
      }
    });
  },
});

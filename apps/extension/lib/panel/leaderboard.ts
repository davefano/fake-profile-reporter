// The Reports tab: profiles reported to the server saves go to.

import type { LeaderboardRow } from '@fpr/core/wire';
import { isError } from '@/lib/runtime';
import { sendMessage } from '@/lib/scan/messages';
import { esc } from './format';
import { avatar } from './views';

let boardLoaded = false;

/** Load again next time the tab opens (after a report). */
export const invalidateLeaderboard = () => (boardLoaded = false);

export async function loadLeaderboard(list: HTMLElement) {
  if (boardLoaded) return;
  list.innerHTML = '<div class="skel row"></div>'.repeat(5);
  const res = await sendMessage<'FPR_LEADERBOARD'>({ type: 'FPR_LEADERBOARD' }).catch(() => undefined);
  const rows: LeaderboardRow[] | undefined = res && !isError(res) ? res.rows : undefined;
  if (!rows) {
    list.innerHTML = `<div class="empty"><h2>Reports unavailable</h2><p>${esc(res && isError(res) ? (res.message ?? res.error) : 'Could not load it.')}</p></div>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><h2>No reports yet</h2><p>Profiles reported to this server show up here.</p></div>';
    return;
  }
  list.innerHTML = `<ol class="board">${rows
    .map((r, i) => {
      return `<li>
        <span class="rank">${i + 1}</span>
        ${avatar(null, r.name, 'sm')}
        <a class="b-name" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.name)}<small>${r.reports} report${r.reports === 1 ? '' : 's'}</small></a>
        <span class="b-score level-${r.level}">${r.score}</span>
      </li>`;
    })
    .join('')}</ol>`;
  boardLoaded = true;
}

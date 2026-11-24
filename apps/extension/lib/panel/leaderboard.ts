// The Reports tab: profiles reported to the server saves go to.

import type { LeaderboardRow } from '@fpr/core/wire';
import { isError } from '@/lib/runtime';
import { sendMessage } from '@/lib/scan/messages';
import { esc } from './format';
import { countsText } from './report-form';
import { levelTag, listTitle } from './saved';
import { avatar } from './views';

let boardLoaded = false;

/** Load again next time the tab opens (after a report). */
export const invalidateLeaderboard = () => (boardLoaded = false);

export async function loadLeaderboard(list: HTMLElement) {
  if (boardLoaded) return;
  list.innerHTML = `<div class="skel-list" aria-busy="true"><div class="skel w40"></div>${'<div class="skel-row"><div class="skel av"></div><div class="skel-lines"><div class="skel w70"></div><div class="skel w40"></div></div><div class="skel tg"></div></div>'.repeat(5)}<p class="loading-step" role="status">Loading reports…</p></div>`;
  const res = await sendMessage<'FPR_LEADERBOARD'>({ type: 'FPR_LEADERBOARD' }).catch(() => undefined);
  const rows: LeaderboardRow[] | undefined = res && !isError(res) ? res.rows : undefined;
  if (!rows) {
    list.innerHTML = `<div class="empty"><h2>Reports unavailable</h2><p>${esc(res && isError(res) ? (res.message ?? res.error) : 'Could not load it.')}</p></div>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><h2>No reports yet</h2><p>Profiles reported as suspicious on this server show up here.</p></div>';
    return;
  }
  list.innerHTML = `<section class="sec">${listTitle('Reported profiles', rows.length)}<ol class="board">${rows
    .map((r, i) => {
      return `<li>
        <span class="rank">${i + 1}</span>
        ${avatar(null, r.name, 'sm')}
        <a class="b-name" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.name)}<small>${esc(countsText(r))}</small></a>
        ${levelTag(r.level)}
      </li>`;
    })
    .join('')}</ol></section>`;
  boardLoaded = true;
}

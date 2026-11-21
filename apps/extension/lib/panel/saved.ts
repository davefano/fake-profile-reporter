// The Saved tab: everything Track or Report kept in this browser.

import { localSaves, type SavedItem } from '@/lib/saves/store';
import { ago, esc } from './format';
import { avatar } from './views';

const KIND = { profile: 'Profile', company: 'Company', job: 'Job' } as const;

export async function loadSaved(list: HTMLElement) {
  const items = await localSaves()
    .list()
    .catch(() => [] as SavedItem[]);
  if (!items.length) {
    list.innerHTML = '<div class="empty"><h2>Nothing saved yet</h2><p>Use Track or Report on a profile, company, or job and it shows up here.</p></div>';
    return;
  }
  list.innerHTML = `<ul class="board">${items
    .map((i) => {
      const when = i.reportedAt !== null ? `Reported ${ago(i.reportedAt)}` : `Saved ${ago(i.savedAt)}`;
      return `<li>
        ${avatar(null, i.name, 'sm')}
        <a class="b-name" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.name)}<small>${KIND[i.kind]} · ${esc(when)}${i.detail ? ` · ${esc(i.detail)}` : ''}</small></a>
        <span class="b-score level-${i.level}">${Math.round(i.score)}</span>
      </li>`;
    })
    .join('')}</ul>`;
}

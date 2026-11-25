// The Saved tab: everything Save or Report kept in this browser.

import type { RiskLevel } from '@fpr/core/scam';
import { localSaves, type SavedItem } from '@/lib/saves/store';
import { ago, esc } from './format';
import { avatar, LEVEL } from './views';

const KIND = { profile: 'Profile', company: 'Company', job: 'Job' } as const;
const SAID = { report: 'Reported', impersonated: 'Flagged as impersonated', vouch: 'Vouched for' } as const;

/** A row's suspicion level: its word in a boxed tag, coloured by level. */
export const levelTag = (level: RiskLevel) => `<span class="b-lvl level-${level}"><span class="tag">${LEVEL[level]}</span></span>`;

/** A list title in the results' style: title, checker rule, count. */
export const listTitle = (title: string, count: number) => `<h3>${esc(title)}<span class="rule" aria-hidden="true"></span><small>${count}</small></h3>`;

export async function loadSaved(list: HTMLElement) {
  const items = await localSaves()
    .list()
    .catch(() => [] as SavedItem[]);
  if (!items.length) {
    list.innerHTML = '<div class="empty"><h2>Nothing saved yet</h2><p>Use Save or Report on a profile, company, or job and it shows up here.</p></div>';
    return;
  }
  list.innerHTML = `<section class="sec">${listTitle('Saved in this browser', items.length)}<ul class="board">${items
    .map((i) => {
      const when = i.report ? `${SAID[i.report.stance]} ${ago(i.report.at)}` : `Saved ${ago(i.savedAt)}`;
      return `<li>
        ${avatar(null, i.name, 'sm')}
        <a class="b-name" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.name)}<small>${KIND[i.kind]} · ${esc(when)}${i.detail ? ` · ${esc(i.detail)}` : ''}</small></a>
        ${levelTag(i.level)}
      </li>`;
    })
    .join('')}</ul></section>`;
}

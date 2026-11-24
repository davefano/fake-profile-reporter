// Where saves go: "Just me" (this browser), "Community" (the shared
// database), or "My own server". Saves are always kept in this browser too.

import { COMMUNITY_URL } from '@/lib/config';
import type { PaletteChoice } from '@/lib/panel/palettes';

export type SaveMode = 'local' | 'community' | 'custom';

export interface Settings {
  mode: SaveMode;
  /** Origin of "My own server", once connected. */
  customUrl: string;
  /** Servers we already offered to upload earlier saves to. Asked once each. */
  offeredUpload: string[];
  /** Settings › Appearance. */
  palette: PaletteChoice;
}

const KEY = 'settings';
const DEFAULTS: Settings = { mode: 'local', customUrl: '', offeredUpload: [], palette: 'system' };

export async function getSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULTS, ...raw };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export const onSettingsChanged = (fn: () => void) =>
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) fn();
  });

/** The server saves also go to, or null for "Just me". */
export function serverBase(s: Settings): string | null {
  if (s.mode === 'community') return COMMUNITY_URL;
  if (s.mode === 'custom') return normalizeServer(s.customUrl);
  return null;
}

/** What the panel calls the destination. */
export function destinationLabel(s: Settings): string {
  if (s.mode === 'community') return 'the community database';
  const base = serverBase(s);
  return base ? new URL(base).host : 'this browser';
}

/** "reports.example.org/" → "https://reports.example.org"; null if it isn't a web address. */
export function normalizeServer(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

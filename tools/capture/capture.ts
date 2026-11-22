#!/usr/bin/env bun
// Capture LinkedIn profile snapshots through a logged-in agent-browser session,
// using the same captureProfile() code the extension runs. Company and job URLs
// are read from LinkedIn's public pages instead and need no browser.
//
//   bun run capture <slug|profile URL|company URL|job URL> [...more] [--no-activity] [--signed-in] [--post http://localhost:8787]
//
// --signed-in adds the logged-in extras for companies and jobs (apply link,
// verified-job badge, employee sample) through the agent-browser session.
//
// Requires agent-browser with a LinkedIn-logged-in session (AGENT_BROWSER_SESSION,
// default "linkedin"). Raw snapshots are saved gzipped under .data/snapshots/.
// This drives your own LinkedIn account: keep it to a handful of profiles.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  extractProfileFacts,
  getCompany,
  getJob,
  observeProfile,
  linkedInTarget,
  type CompanyExtras,
  type JobExtras,
  type ProfileFacts,
  type RawSnapshot,
} from '@fpr/core/linkedin';
import { scoreCompany, scoreJob, scoreProfile, type Score } from '@fpr/core/scam';

const ROOT = join(import.meta.dir, '../..');
const SNAP_DIR = join(ROOT, '.data/snapshots');
const DELAY_MS = 4000; // between profiles, to stay at human pace

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const postTo = option('--post');
const targets = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--post');
if (!targets.length) {
  console.error('usage: bun run capture <slug|profile URL> [...] [--no-activity] [--post <apiBase>]');
  process.exit(1);
}

const env = { ...process.env, AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION ?? 'linkedin' };

function ab(argv: string[], stdin?: string): string {
  const r = Bun.spawnSync(['agent-browser', ...argv], { env, stdin: stdin ? new TextEncoder().encode(stdin) : undefined });
  if (r.exitCode !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${r.stderr.toString() || r.stdout.toString()}`);
  return r.stdout.toString();
}

async function bundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, 'page-entry.ts')], format: 'iife', minify: true, target: 'browser' });
  if (!out.success) throw new Error(out.logs.join('\n'));
  return out.outputs[0]!.text();
}

function slugOf(t: string) {
  const target = linkedInTarget(t.includes('/') ? (/^https?:/.test(t) ? t : `https://${t.replace(/^\/+/, '')}`) : `https://www.linkedin.com/in/${t}/`);
  return target?.kind === 'profile' ? target.slug : null;
}

/**
 * The member's current facts from earlier runs: current.json, or else rebuilt
 * by folding every saved snapshot through observeProfile (the same rule as the
 * extension and the directory).
 */
function currentFacts(memberId: number): ProfileFacts | null {
  const dir = join(SNAP_DIR, String(memberId));
  try {
    return JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as ProfileFacts;
  } catch {
    // not saved yet: rebuild below
  }
  let facts: ProfileFacts | null = null;
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json.gz')).sort()) {
      const snap: RawSnapshot = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'));
      facts = observeProfile(facts, extractProfileFacts(snap, snap.capturedAt)).current;
    }
  } catch {
    // no snapshots yet
  }
  return facts;
}

const fmtDate = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

// --- companies and jobs: public pages, no browser ---------------------------------

// LinkedIn blocks Bun's HTTP client on some public pages (it accepts curl), so
// shell out to curl. The extension uses the browser's fetch instead.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36';
const publicFetch = async (url: string) => {
  const r = Bun.spawnSync(['curl', '-sS', '-L', '--max-time', '30', '-A', UA, '-w', '\n%{http_code}', url]);
  if (r.exitCode !== 0) throw new Error(`curl failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout.toString();
  const cut = out.lastIndexOf('\n');
  return new Response(out.slice(0, cut), { status: Number(out.slice(cut + 1)) || 599 });
};
const publicOpts = { fetch: publicFetch, base: 'https://www.linkedin.com' };

// The page bundle and a LinkedIn tab, set up on first use.
let pageCode: string | null = null;
async function inPage<T>(call: string): Promise<T> {
  if (!pageCode) {
    pageCode = await bundle();
    // Requests must be same-origin with linkedin.com.
    if (!ab(['get', 'url']).includes('www.linkedin.com')) ab(['open', 'https://www.linkedin.com/feed/']);
  }
  const out = JSON.parse(ab(['--json', 'eval', '--stdin'], `${pageCode}\n;(${call}).then(r => JSON.stringify(r))`));
  const result = out.data?.result ?? out.data;
  return JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
}
// Signed-in extras through the browser session, for the core getters.
const signedIn = flag('--signed-in')
  ? {
      company: (slug: string) => inPage<CompanyExtras>(`__fprCompanyExtras(${JSON.stringify(slug)})`),
      job: (id: string) => inPage<JobExtras>(`__fprJobExtras(${JSON.stringify(id)})`),
    }
  : undefined;
const extrasLine = (label: string, x: object) => console.log(`   ${label}: ${JSON.stringify(x)}`);

function printScore(score: Score, indent = '   ') {
  console.log(`${indent}SCORE ${score.score} (${score.level})`);
  for (const s of score.signals) console.log(`${indent}  ${s.weight > 0 ? '+' : ''}${s.weight}\t${s.kind === 'discrepancy' ? '! ' : ''}${s.label}`);
  if (score.missing.length) console.log(`${indent}not checked: ${score.missing.join('; ')}`);
}

const profileTargets: string[] = [];
let publicCount = 0;
for (const target of targets) {
  // A bare long number is a job ID; anything else that isn't a URL is a profile slug.
  const url = /^https?:/.test(target) ? target : /^\d{8,}$/.test(target) ? `https://www.linkedin.com/jobs/view/${target}/` : `https://www.linkedin.com/${target}`;
  const t = linkedInTarget(url);
  if (t?.kind !== 'company' && t?.kind !== 'job') {
    profileTargets.push(target);
    continue;
  }
  if (publicCount++ > 0) await Bun.sleep(DELAY_MS);
  try {
    if (t.kind === 'company') {
      const { facts: f, errors } = await getCompany(t.slug, { ...publicOpts, signedIn: signedIn?.company });
      console.log(`\n━━ ${f.name}  (company/${f.slug})  id ${f.companyId ?? '?'}`);
      console.log(`   ${[f.industry, f.headquarters].filter(Boolean).join(' · ')}`);
      console.log(`   founded ${f.foundedYear ?? '—'} · claims ${f.claimedSize?.label ?? '—'} · ${f.employeesOnLinkedIn ?? '—'} on LinkedIn · ${f.followers?.toLocaleString('en-US') ?? '—'} followers · ${f.website ?? 'no website'}`);
      if (f.extras) extrasLine('signed-in', f.extras);
      printScore(scoreCompany(f));
      if (Object.keys(errors).length) console.log(`   errors: ${JSON.stringify(errors)}`);
    } else {
      const { job: f, company: co, errors } = await getJob(t.id, { ...publicOpts, signedIn });
      const companyScore = co ? scoreCompany(co) : null;
      console.log(`\n━━ ${f.title}  (job ${f.jobId})`);
      console.log(`   ${[f.company.name, f.location, f.postedText, f.applicants ? `${f.applicants.count} applicants` : null].filter(Boolean).join(' · ')}`);
      console.log(`   ${[f.employmentType, f.seniority, f.salary?.text, f.apply === 'easy' ? 'Easy Apply' : f.apply === 'offsite' ? 'apply on company site' : null].filter(Boolean).join(' · ')}`);
      if (f.extras) extrasLine('signed-in', f.extras);
      printScore(scoreJob(f, co, companyScore));
      if (co && companyScore) {
        if (co.extras) extrasLine('company signed-in', co.extras);
        console.log(`   company: ${co.name} (${co.employeesOnLinkedIn ?? '—'} on LinkedIn)`);
        printScore(companyScore, '     ');
      }
      if (Object.keys(errors).length) console.log(`   errors: ${JSON.stringify(errors)}`);
    }
  } catch (e) {
    console.log(`\n━━ ${target}\n   could not read: ${e instanceof Error ? e.message : e}`);
  }
}
if (!profileTargets.length) process.exit(0);

// --- profiles: logged-in browser ----------------------------------------------------

for (const [n, target] of profileTargets.entries()) {
  const slug = slugOf(target);
  if (!slug) {
    console.error(`skip: not a profile: ${target}`);
    continue;
  }
  if (n > 0) await Bun.sleep(DELAY_MS);

  const opts = JSON.stringify({ includeActivity: !flag('--no-activity') });
  const snap = await inPage<RawSnapshot>(`__fprCapture(${JSON.stringify(slug)}, ${opts})`);

  const facts = extractProfileFacts(snap, snap.capturedAt);
  if (!facts.memberId) {
    // Nothing to score: an empty capture would look suspicious for the wrong reason.
    console.log(`\n━━ ${slug}\n   profile unavailable (removed, restricted, or the slug changed); not scored`);
    console.log(`   errors: ${JSON.stringify(snap.errors)}`);
    continue;
  }
  const gz = gzipSync(JSON.stringify(snap));
  // Same rule as the extension and the directory: failed parts keep the last
  // capture's values, and the score uses the merged facts.
  const { current, changes, carried } = observeProfile(currentFacts(facts.memberId), facts);
  const score = scoreProfile(current, snap.capturedAt);
  const dir = join(SNAP_DIR, String(facts.memberId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${new Date(snap.capturedAt).toISOString().replace(/[:.]/g, '-')}.json.gz`), gz, { mode: 0o600 });
  writeFileSync(join(dir, 'current.json'), JSON.stringify(current), { mode: 0o600 });

  // Print what was scored: the merged current facts.
  const f = current;
  const name = [f.firstName, f.lastName].filter(Boolean).join(' ') || slug;
  console.log(`\n━━ ${name}  (${f.slug})  member ${f.memberId ?? '?'}`);
  console.log(`   ${f.headline ?? ''}`);
  console.log(
    `   joined ${fmtDate(f.joined?.at)}${f.joined?.source === 'memberId' ? ' (est.)' : ''}` +
      ` · connections ${f.connections ? f.connections.count + (f.connections.capped ? '+' : '') : '—'}` +
      ` · followers ${f.followers?.toLocaleString('en-US') ?? '—'}` +
      ` · last activity ${fmtDate(f.activity?.newestAt)}` +
      ` · verified ${f.about ? (f.about.verifications.length ? 'yes' : 'no') : '—'}`,
  );
  if (carried.length) console.log(`   not read this time, shown from an earlier capture: ${carried.join(', ')}`);
  printScore(score);
  if (Object.keys(snap.errors).length) console.log(`   errors: ${JSON.stringify(snap.errors)}`);
  if (changes.length) console.log(`   changed since last capture: ${changes.map((c) => c.field).join(', ')}`);
  console.log(`   snapshot ${(gz.length / 1024).toFixed(0)} KB gzipped`);

  if (postTo) {
    const res = await fetch(`${postTo.replace(/\/$/, '')}/api/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: gz,
    });
    console.log(`   posted → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

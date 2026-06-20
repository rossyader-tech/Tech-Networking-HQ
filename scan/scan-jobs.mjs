/**
 * Networking HQ — scheduled job scanner
 * Runs in GitHub Actions (Mon & Thu AM). For each target company that has a
 * Careers URL set, it fetches the page, asks Claude for any open role with
 * marketing / partnerships / growth in the title, dedupes against your
 * pipeline, and appends only NEW ones to your Jobs tab via the append-only
 * endpoint (so it can never overwrite your edits).
 *
 * Env (provided by the workflow from repo Secrets):
 *   SYNC_URL           your Apps Script /exec URL
 *   ANTHROPIC_API_KEY  your Anthropic key
 *   MODEL              optional, defaults to claude-sonnet-4-6
 *   DRY_RUN            optional, 'true' = scan + summarize but don't write
 */
import fs from 'node:fs';

const SYNC_URL = process.env.SYNC_URL;
const API_KEY  = process.env.ANTHROPIC_API_KEY;
const MODEL    = process.env.MODEL || 'claude-sonnet-4-6';
const DRY_RUN  = (process.env.DRY_RUN || '').toLowerCase() === 'true';

const TITLE_RE = /market|partner|growth|affiliate|demand gen|biz ?dev|business development/i;

function out(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { fs.appendFileSync(f, md + '\n'); } catch (_) {} }
  console.log(md.replace(/[#*`]/g, ''));
}
function today() { return new Date().toISOString().slice(0, 10); }
function uid() { return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function canon(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function jobKey(c, t) { return canon(c) + '|' + canon(t); }

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NetworkingHQ-bot/1.0)', 'accept': 'text/html,application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.text();
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 12000);
  } finally { clearTimeout(t); }
}

async function askClaude(company, text) {
  const sys = `You are scanning the careers page of "${company}" for a job seeker focused on performance & partner marketing. From the page text, list ONLY currently-open roles whose TITLE contains marketing, partner/partnerships, growth, affiliate, or demand gen. Return ONLY a JSON array; each item {"title","url","level","location"}. "url" = the role's listing/apply link if present, else "". "level" = Manager / Lead / Director / Sr Director / VP if inferable, else "". If none qualify, return []. Never invent roles that aren't in the text.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: sys + '\n\nPAGE TEXT:\n' + text + '\n\nReturn the JSON array only.' }] })
  });
  if (!r.ok) throw new Error('Anthropic HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  let s = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/```json|```/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return []; }
}

async function main() {
  if (!SYNC_URL || !API_KEY) {
    out('## ❌ Job scan skipped\nMissing `SYNC_URL` or `ANTHROPIC_API_KEY` repo secret.');
    process.exit(1);
  }
  out('## 🔎 Networking HQ — job scan · ' + today() + (DRY_RUN ? ' _(dry run)_' : ''));

  // 1) read current data
  let db;
  try {
    const r = await fetch(SYNC_URL + (SYNC_URL.includes('?') ? '&' : '?') + 'action=read&t=' + Date.now());
    db = await r.json();
  } catch (e) {
    out('Could not read your Sheet: ' + e.message);
    process.exit(1);
  }
  const companies = (db.companies || []).filter(c => !c.archived && (c.tier === 'A' || c.tier === 'B') && c.careersSite);
  const existing = new Set((db.jobs || []).map(j => jobKey(j.company, j.title)));

  if (!companies.length) {
    out('No target companies have a **Careers URL** set yet. Add one on a company card and the scanner will cover it next run.');
    return;
  }

  // 2) scan each company
  const found = [];
  const lines = [];
  for (const co of companies) {
    try {
      const text = await fetchText(co.careersSite);
      const roles = (await askClaude(co.name, text)).filter(r => r && r.title && TITLE_RE.test(r.title));
      let added = 0;
      for (const role of roles) {
        const k = jobKey(co.name, role.title);
        if (existing.has(k)) continue;
        existing.add(k);
        found.push({
          id: uid(), company: co.name, title: String(role.title).trim(),
          level: role.level || '', comp: '', status: 'Found',
          location: role.location || '', remote: '', url: role.url || co.careersSite,
          fit: '', function: '', snippet: '', nextAction: 'Review — auto-found',
          notes: '', found: today(), source: 'auto-scan'
        });
        added++;
      }
      lines.push(`- **${co.name}** — ${added} new` + (roles.length ? ` (${roles.length} matched)` : ''));
    } catch (e) {
      lines.push(`- ${co.name} — skipped (${e.message})`);
    }
  }

  // 3) write new roles (append-only)
  if (found.length && !DRY_RUN) {
    try {
      const r = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'addJobs', jobs: found })
      });
      const res = await r.json().catch(() => ({}));
      out(`### ✅ Added ${res.added != null ? res.added : found.length} new role(s) to your Jobs tab`);
    } catch (e) {
      out('### ⚠️ Found roles but could not write them: ' + e.message);
    }
  } else if (found.length) {
    out(`### (dry run) Would add ${found.length} new role(s)`);
  } else {
    out('### No new roles this run');
  }

  out('\n**Companies scanned (' + companies.length + ')**');
  out(lines.join('\n'));
  if (found.length) {
    out('\n**New roles**');
    out(found.map(j => `- ${j.title} — ${j.company}`).join('\n'));
  }
}

main().catch(e => { out('## ❌ Scan failed\n' + (e && e.stack ? e.stack : e)); process.exit(1); });

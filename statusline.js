#!/usr/bin/env node
// claude-status — status line for Claude Code.
// Model-aware context window + rate limits + cache-hit % + styled output.
// Reads JSON from stdin, writes an ANSI-styled status line to stdout.
//
// Install: `npx claude-status` or `node install.js` from a clone.
// Repo:    https://github.com/waelmas/claude-status

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const proc = require('child_process');

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const R  = '\x1b[0m';
const B  = '\x1b[1m';
const DM = '\x1b[2m';
const c  = (n) => `\x1b[38;5;${n}m`;

const PURPLE = c(135);
const CYAN   = c(87);
const GREEN  = c(83);
const YELLOW = c(220);
const ORANGE = c(208);
const RED    = c(196);
const PINK   = c(213);
const GRAY   = c(244);
const WHITE  = c(255);
const BLUE   = c(75);
const TEAL   = c(51);
const GOLD   = c(178);
const LIME   = c(154);

// ── Parse stdin ───────────────────────────────────────────────────────────────
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf-8'));
} catch (e) {
  process.stdout.write('status: parse error');
  process.exit(0);
}

// ── Project + Git ─────────────────────────────────────────────────────────────
const cwd         = input.workspace?.current_dir || input.cwd || process.cwd();
const projectName = path.basename(cwd);

function git(args) {
  try {
    const r = proc.spawnSync('git', args, {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch (e) { return ''; }
}

const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD']);
let branch      = branchRaw && branchRaw !== 'HEAD' ? branchRaw : '';
if (branch.length > 22) branch = branch.slice(0, 21) + '…';
const statusOut = git(['status', '--porcelain']);
const dirty     = statusOut.length > 0;

// ── Model ─────────────────────────────────────────────────────────────────────
const modelDisplayName = input.model?.display_name || 'Claude';
let modelShort = modelDisplayName
  .replace(/^Claude\s+/, '')
  .replace(/\s*\([^)]*\)\s*/g, '')   // strip parenthetical context-window tags like "(1M context)"
  .trim();
if (modelShort.length > 20) modelShort = modelShort.slice(0, 19) + '…';

// ── Effort level (from ~/.claude/settings.json; not in statusline payload) ───
// Cost increases with effort: low=cheap thought, medium=baseline, high=good
// value, xhigh=expensive (warn), max=very expensive (danger).
function readEffortLevel() {
  try {
    const home = os.homedir();
    const raw  = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8');
    return (JSON.parse(raw).effortLevel || '').toLowerCase();
  } catch (e) { return ''; }
}
const effortLevel = readEffortLevel();
const EFFORT_MAP  = {
  low:    { label: 'LO', col: GRAY,   dim: true  },  // meh
  medium: { label: 'MD', col: CYAN,   dim: false },  // normal baseline
  high:   { label: 'HI', col: GREEN,  dim: false },  // sweet spot
  xhigh:  { label: 'XH', col: YELLOW, dim: false },  // cost warning
  max:    { label: 'MX', col: RED,    dim: false },  // danger zone
};
const effortInfo  = EFFORT_MAP[effortLevel];
const effortBadge = effortInfo
  ? `${effortInfo.dim ? DM : ''}${effortInfo.col}${B}${effortInfo.label}${R}`
  : '';

// ── Context Window (uses actual model ceiling from JSON) ──────────────────────
const ctx        = input.context_window || {};
const windowSize = ctx.context_window_size || 0;   // real ceiling for this model
const usedPct    = ctx.used_percentage;             // null if no messages yet
const hasData    = usedPct != null;

// Billed input (what ctx.total_input_tokens tracks): fresh/uncached only.
// Parse the transcript to compute cache_read and cache_creation volumes so
// we can show an honest cache-hit %. Size-keyed cache keeps repaints cheap.
function readSessionCacheStats(transcriptPath, sessionId) {
  if (!transcriptPath) return { cacheRead: 0, cacheCreate: 0 };
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch (e) { return { cacheRead: 0, cacheCreate: 0 }; }

  const cachePath = path.join(os.tmpdir(), `statusline-cache-${sessionId || 'x'}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (cached.size === stat.size) return { cacheRead: cached.cacheRead, cacheCreate: cached.cacheCreate };
  } catch (e) {}

  let cacheRead = 0, cacheCreate = 0;
  try {
    const data = fs.readFileSync(transcriptPath, 'utf-8');
    for (const line of data.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') continue;
        const u = obj.message?.usage;
        if (!u) continue;
        cacheRead   += (u.cache_read_input_tokens || 0);
        cacheCreate += (u.cache_creation_input_tokens || 0);
      } catch (e) {}
    }
  } catch (e) {}

  try { fs.writeFileSync(cachePath, JSON.stringify({ size: stat.size, cacheRead, cacheCreate })); } catch (e) {}
  return { cacheRead, cacheCreate };
}

const totalIn    = ctx.total_input_tokens  || 0;   // billed/uncached input
const totalOut   = ctx.total_output_tokens || 0;
const cacheStats = readSessionCacheStats(input.transcript_path, input.session_id);
// Cache-hit % = cache_read / (cache_read + cache_creation + fresh_input).
// Includes cache_creation in the denominator since those tokens ARE billed
// (at the write rate) — so they're honestly "not a hit."
const totalInputVolume = cacheStats.cacheRead + cacheStats.cacheCreate + totalIn;
const cacheHitPct = totalInputVolume > 0
  ? (cacheStats.cacheRead / totalInputVolume) * 100
  : 0;

const curUsage  = ctx.current_usage;
const curCtxTok = curUsage
  ? (curUsage.input_tokens || 0)
    + (curUsage.cache_creation_input_tokens || 0)
    + (curUsage.cache_read_input_tokens || 0)
    + (curUsage.output_tokens || 0)
  : 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function ctxBar(pct, width) {
  const filled = Math.min(width, Math.round((pct / 100) * width));
  let col;
  if (pct < 50)      col = GREEN;
  else if (pct < 75) col = LIME;
  else if (pct < 90) col = YELLOW;
  else if (pct < 95) col = ORANGE;
  else               col = RED;
  return GRAY + '[' + col + '█'.repeat(filled) + DM + '░'.repeat(width - filled) + R + GRAY + ']' + R;
}

// ── Rate limits ───────────────────────────────────────────────────────────────
const rl      = input.rate_limits || {};
const fiveHr  = rl.five_hour;
const sevenDy = rl.seven_day;

// Compact "time until" formatter: 45m, 3h, 2d, 2d4h.
function fmtUntil(resetsAtSec) {
  if (!resetsAtSec) return '';
  const diff = resetsAtSec - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'now';
  if (diff < 3600) {
    // Avoid "60m" at the boundary — roll up to "1h" when rounding would overflow.
    const mins = Math.max(1, Math.round(diff / 60));
    return mins >= 60 ? '1h' : `${mins}m`;
  }
  if (diff < 86400) {
    const hrs = Math.round(diff / 3600);
    return hrs >= 24 ? '1d' : `${hrs}h`;
  }
  const days  = Math.floor(diff / 86400);
  const hours = Math.round((diff - days * 86400) / 3600);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

function fmtRL(obj, label) {
  if (!obj) return '';
  const p    = obj.used_percentage;
  const col  = p < 60 ? GREEN : p < 80 ? YELLOW : RED;
  const when = fmtUntil(obj.resets_at);
  const tail = when ? `${DM}${GRAY}·${when}${R}` : '';
  return `${GRAY}${label}:${col}${p.toFixed(0)}%${R}${tail}`;
}

// ── Vim mode ──────────────────────────────────────────────────────────────────
const vim    = input.vim;
let vimBadge = '';
if (vim) {
  vimBadge = vim.mode === 'INSERT'
    ? `${GREEN}${B}INS${R}`
    : `${YELLOW}${B}NRM${R}`;
}

// ── Optional badges ───────────────────────────────────────────────────────────
const agentBadge    = input.agent?.name    ? `${PINK}⬡ ${input.agent.name}${R}` : '';
const worktreeBadge = input.worktree?.name ? `${TEAL}⎇ ${input.worktree.name}${R}` : '';
const styleName     = input.output_style?.name;
const styleBadge    = (styleName && styleName !== 'default') ? `${GOLD}✳ ${styleName}${R}` : '';

// ── Assemble segments ─────────────────────────────────────────────────────────
const SEP   = `${DM}${GRAY} ┃ ${R}`;
const parts = [];

// 1. Project + branch
{
  let proj = `${CYAN}${B}${projectName}${R}`;
  if (branch) {
    const dot = dirty ? `${ORANGE}●${R}` : '';
    proj += ` ${GRAY}on${R} ${PURPLE}${branch}${R}${dot}`;
  }
  parts.push(proj);
}

// 2. Model + effort badge
{
  let modelPart = `${BLUE}${B}${modelShort}${R}`;
  if (effortBadge) modelPart += ` ${effortBadge}`;
  parts.push(modelPart);
}

// 3. Context bar + %used/ceiling
if (hasData && windowSize > 0) {
  const pct     = usedPct.toFixed(1);
  const usedTok = fmtK(curCtxTok);
  const winTok  = fmtK(windowSize);
  parts.push(`${ctxBar(usedPct, 8)} ${WHITE}${B}${pct}%${R} ${GRAY}${usedTok}${DM}/${winTok}${R}`);
} else {
  parts.push(`${GRAY}ctx: --${R}`);
}

// 4. Rate limits (prioritized — subscription caps matter for pacing)
const r5 = fmtRL(fiveHr, '5h');
const r7 = fmtRL(sevenDy, '7d');
if (r5 || r7) parts.push([r5, r7].filter(Boolean).join(' '));

// 5. Session totals (cumulative — pushed to the end)
if (hasData && (totalIn > 0 || totalOut > 0)) {
  let totGroup = `${DM}${GRAY}in↑${R}${WHITE}${fmtK(totalIn)}${R}`;
  if (cacheHitPct > 0) {
    const hitStr = cacheHitPct >= 99.5 ? cacheHitPct.toFixed(1) : cacheHitPct.toFixed(0);
    const hitCol = cacheHitPct >= 95 ? GREEN : cacheHitPct >= 80 ? LIME : cacheHitPct >= 60 ? YELLOW : ORANGE;
    totGroup += `${DM}${GRAY}(${hitCol}+${hitStr}%${DM}${GRAY} cached)${R}`;
  }
  totGroup += ` ${DM}${GRAY}out↓${R}${WHITE}${fmtK(totalOut)}${R}`;
  parts.push(totGroup);
}

// 6. Misc badges
const badges = [vimBadge, agentBadge, worktreeBadge, styleBadge].filter(Boolean);
if (badges.length) parts.push(badges.join(' '));

process.stdout.write(parts.join(SEP));

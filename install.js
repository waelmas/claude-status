#!/usr/bin/env node
// claude-stat — installer / uninstaller for the Claude Code status line.
//
// Usage:
//   npx claude-stat              # install (default)
//   npx claude-stat install      # install (explicit)
//   npx claude-stat uninstall    # remove
//
// Also works from a cloned source tree: `node install.js [install|uninstall]`.
//
// Install does:
//   1. Copies `statusline.js` (from this package) to ~/.claude/statusline-command.js
//   2. Reads ~/.claude/settings.json (creates it if missing)
//   3. Writes a timestamped backup before modifying settings.json
//   4. Sets the `statusLine` entry to invoke the copied script
//
// Uninstall does:
//   1. Removes the `statusLine` key from ~/.claude/settings.json (backup first)
//   2. Deletes ~/.claude/statusline-command.js
//   3. Removes cached transcript totals from os.tmpdir()
//
// Never touches other keys in settings.json. Never installs globally.
// Requires only Node.js.
//
// Repo: https://github.com/waelmas/claude-stat

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HERE         = __dirname;
const SRC_SCRIPT   = path.join(HERE, 'statusline.js');
const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const DEST_SCRIPT  = path.join(CLAUDE_DIR, 'statusline-command.js');
const SETTINGS     = path.join(CLAUDE_DIR, 'settings.json');

function log(msg)  { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

function backupSettings() {
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS}.backup-${stamp}`;
  fs.copyFileSync(SETTINGS, backup);
  log(`✓ backed up existing settings → ${backup}`);
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'));
  } catch (e) {
    fail(`could not parse existing ${SETTINGS}: ${e.message}`);
  }
}

function install() {
  if (!fs.existsSync(SRC_SCRIPT)) {
    fail(`expected ${SRC_SCRIPT} alongside install.js — are you running this from the package dir?`);
  }
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    log(`created ${CLAUDE_DIR}`);
  }

  fs.copyFileSync(SRC_SCRIPT, DEST_SCRIPT);
  fs.chmodSync(DEST_SCRIPT, 0o755);
  log(`✓ copied statusline script → ${DEST_SCRIPT}`);

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    settings = readSettings();
    backupSettings();
  }

  settings.statusLine = {
    type: 'command',
    command: `node ${DEST_SCRIPT}`,
  };

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  log(`✓ updated ${SETTINGS}`);
  log('');
  log('Done. Start a new Claude Code session (or reload) to see the new status line.');
  log('Uninstall any time with:  npx claude-stat uninstall');
}

function uninstall() {
  let removedSomething = false;

  if (fs.existsSync(SETTINGS)) {
    const settings = readSettings();
    if (settings.statusLine) {
      backupSettings();
      delete settings.statusLine;
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
      log(`✓ removed statusLine key from ${SETTINGS}`);
      removedSomething = true;
    } else {
      log(`· no statusLine key in ${SETTINGS} (nothing to remove)`);
    }
  } else {
    log(`· ${SETTINGS} does not exist`);
  }

  if (fs.existsSync(DEST_SCRIPT)) {
    fs.unlinkSync(DEST_SCRIPT);
    log(`✓ deleted ${DEST_SCRIPT}`);
    removedSomething = true;
  } else {
    log(`· ${DEST_SCRIPT} does not exist`);
  }

  try {
    const tmp = os.tmpdir();
    const cachePrefix = 'statusline-cache-';
    for (const entry of fs.readdirSync(tmp)) {
      if (entry.startsWith(cachePrefix) && entry.endsWith('.json')) {
        fs.unlinkSync(path.join(tmp, entry));
        removedSomething = true;
      }
    }
    log('✓ cleared transcript totals cache');
  } catch (e) {
    // Non-fatal; tmp cache is best-effort cleanup.
  }

  log('');
  log(removedSomething
    ? 'Done. claude-stat has been removed. Your existing settings.json backups are preserved.'
    : 'Nothing to uninstall. claude-stat does not appear to be installed.');
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
const cmd = (process.argv[2] || 'install').toLowerCase();
switch (cmd) {
  case 'install':
  case 'i':
    install();
    break;
  case 'uninstall':
  case 'remove':
  case 'u':
    uninstall();
    break;
  case '-h':
  case '--help':
  case 'help':
    log('claude-stat — status line for Claude Code');
    log('');
    log('Usage:');
    log('  npx claude-stat             install (default)');
    log('  npx claude-stat install     install (explicit)');
    log('  npx claude-stat uninstall   remove statusline and clean up');
    log('');
    log('Repo: https://github.com/waelmas/claude-stat');
    break;
  default:
    fail(`unknown command: ${cmd}. Try: install, uninstall, help.`);
}

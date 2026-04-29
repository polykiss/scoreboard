#!/usr/bin/env node
// Update DEFAULT_STATE in server.js to match the current state.json.
// Run after dialing in a configuration you want to ship as the new
// factory default. The script never auto-commits — review the diff
// and commit yourself.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state.json');
const SERVER_FILE = path.join(ROOT, 'server.js');

if (!fs.existsSync(STATE_FILE)) {
  console.error('Error: state.json not found at ' + STATE_FILE);
  process.exit(1);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (err) {
  console.error('Error: state.json is not valid JSON: ' + err.message);
  process.exit(1);
}

// Transient power flags and the user-defaults snapshot are not part of
// the factory defaults. Count always boots at zero.
delete state.shuttingDown;
delete state.rebooting;
delete state.userDefaults;
state.count = 0;

function formatValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    // Single-quoted to match existing server.js style.
    return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }
  return String(v);
}

const indent = '  ';
const lines = [];
for (const [k, v] of Object.entries(state)) {
  lines.push(indent + k + ': ' + formatValue(v) + ',');
}
const newBody = '\n' + lines.join('\n') + '\n';

const serverSrc = fs.readFileSync(SERVER_FILE, 'utf8');
const re = /(const\s+DEFAULT_STATE\s*=\s*\{)[\s\S]*?\n\};/;
if (!re.test(serverSrc)) {
  console.error('Error: could not find DEFAULT_STATE declaration in server.js');
  process.exit(1);
}
const newServerSrc = serverSrc.replace(re, '$1' + newBody + '};');
fs.writeFileSync(SERVER_FILE, newServerSrc);

console.log('Factory defaults updated from state.json');
for (const line of lines) console.log(line);

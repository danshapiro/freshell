import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Zero args (the unit-lane enforcement path) checks the real workspace lock;
// an explicit path targets a fixture lock, which lets the unit tests prove
// drift detection without mutating the repository.
const lockPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(repoRoot, 'pnpm-lock.yaml');

let content;
try {
  content = readFileSync(lockPath, 'utf8');
} catch (err) {
  console.error(`FAIL: cannot read ${lockPath}: ${err.message}`);
  process.exit(1);
}

const lines = content.split('\n');
const unquote = (s) => s.replace(/^['"]|['"]$/g, '');
const baseVersion = (v) => String(v).split('(')[0];
const indentOf = (line) => line.length - line.trimStart().length;
const keyOf = (line) => unquote(line.trim().replace(/:$/, ''));
const topIndex = (name) => lines.findIndex((line) => line === `${name}:`);

const importersStart = topIndex('importers');
const packagesStart = topIndex('packages');
if (importersStart === -1 || packagesStart === -1 || importersStart > packagesStart) {
  console.error(
    `FAIL: pnpm-lock.yaml must have top-level "importers:" and "packages:" sections (importers at ${importersStart}, packages at ${packagesStart})`,
  );
  process.exit(1);
}

const importers = new Map();
let importerPath = null;
let section = null;
let depName = null;
for (let i = importersStart + 1; i < packagesStart; i += 1) {
  const line = lines[i];
  if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
  const indent = indentOf(line);
  if (indent === 2) {
    importerPath = keyOf(line);
    importers.set(importerPath, new Map());
    section = null;
    depName = null;
  } else if (indent === 4 && importerPath !== null) {
    section = keyOf(line);
    depName = null;
    if (!importers.get(importerPath).has(section)) {
      importers.get(importerPath).set(section, new Map());
    }
  } else if (indent === 6 && importerPath !== null && section !== null) {
    depName = keyOf(line);
    importers.get(importerPath).get(section).set(depName, null);
  } else if (indent >= 8 && importerPath !== null && section !== null && depName !== null) {
    const match = line.trim().match(/^version:\s*(.*)$/);
    if (match) {
      importers.get(importerPath).get(section).set(depName, unquote(match[1].trim()));
    }
  }
}

const depVersion = (path, name) => {
  const importer = importers.get(path);
  if (!importer) return undefined;
  for (const sectionMap of importer.values()) {
    const version = sectionMap.get(name);
    if (version !== undefined) return version;
  }
  return undefined;
};

const failures = [];
const assertImporterDep = (path, name, expected) => {
  const observed = depVersion(path, name);
  if (observed === undefined) {
    failures.push(`${path}: dependency ${name} is missing`);
  } else if (baseVersion(observed) !== expected) {
    failures.push(`${path}: dependency ${name} expected base version ${expected}, observed ${observed}`);
  }
};

assertImporterDep('.', 'zod', '4.3.6');
assertImporterDep('.', 'undici', '7.30.0');
assertImporterDep('crates/freshell-claude-sidecar', '@anthropic-ai/claude-agent-sdk', '0.3.237');
assertImporterDep('crates/freshell-claude-sidecar', '@anthropic-ai/sdk', '0.120.0');
assertImporterDep('crates/freshell-claude-sidecar', '@modelcontextprotocol/sdk', '1.30.0');
assertImporterDep('crates/freshell-claude-sidecar', 'zod', '4.4.3');
assertImporterDep('packages/freshell-mcp-runtime', '@modelcontextprotocol/sdk', '1.30.0');
assertImporterDep('packages/freshell-mcp-runtime', 'undici', '7.30.0');
assertImporterDep('packages/freshell-mcp-runtime', 'zod', '4.3.6');

const packageKeys = new Set();
for (let i = packagesStart + 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.trim() === '') continue;
  if (indentOf(line) === 0) break;
  if (indentOf(line) === 2) packageKeys.add(keyOf(line));
}
for (const expected of ['zod@4.3.6', 'zod@4.4.3']) {
  if (!packageKeys.has(expected)) {
    failures.push(`packages: expected key ${expected} to exist`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log('WORKSPACE PEERS OK');

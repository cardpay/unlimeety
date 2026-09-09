import { mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import runner from './runner-manifest.js';
import { downloadPinnedArchive } from './runner-download.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const archive = join(root, '.runner.tar.gz');
const unpacked = join(root, '.runner-unpacked');
const output = join(root, 'bin', runner.outputName);

function fail(message) { throw new Error(message); }

function findBinary(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, name.name);
    if (name.isDirectory()) { const found = findBinary(child); if (found) return found; }
    if (name.isFile() && name.name === runner.archiveBinary) return child;
  }
  return null;
}

async function download() {
  await downloadPinnedArchive({
    url: new URL(runner.archiveUrl), target: archive,
    expectedSha256: runner.archiveSha256,
    approvedHosts: new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']),
  });
}

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('The local runner is packaged only for macOS arm64.');
  rmSync(archive, { force: true });
  rmSync(unpacked, { recursive: true, force: true });
  await download();
  mkdirSync(unpacked, { recursive: true });
  if (spawnSync('tar', ['-xzf', archive, '-C', unpacked]).status !== 0) fail('Could not unpack verified runner archive.');
  const binary = findBinary(unpacked);
  if (!binary) fail('Verified runner archive did not contain the reviewed binary.');
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(binary, output, 0);
  // The macOS release links llama-cli against sibling lib*.dylib files. Keep
  // the verified runtime's relative layout when it is embedded in Contents/MacOS.
  for (const name of readdirSync(dirname(binary))) {
    if (/^lib.+\.dylib$/.test(name)) copyFileSync(join(dirname(binary), name), join(dirname(output), basename(name)), 0);
  }
  if (spawnSync('chmod', ['755', output]).status !== 0) fail('Could not mark local runner executable.');
} finally {
  rmSync(archive, { force: true });
  rmSync(unpacked, { recursive: true, force: true });
}

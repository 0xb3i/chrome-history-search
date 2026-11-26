import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_HOST_NAME,
  createNativeMessageParser,
  encodeNativeMessage,
  resolveDataFilePath
} from '../native-host/host.mjs';
import {
  deriveExtensionIdFromPublicKey,
  installNativeHost,
  uninstallNativeHost
} from '../native-host/install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCRIPT = path.join(REPO_ROOT, 'native-host', 'host.mjs');
const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');

function startHostProcess(command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const received = [];
  const waiters = [];
  let stderr = '';

  const feed = createNativeMessageParser((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else received.push(message);
  });

  child.stdout.on('data', (chunk) => feed(chunk));
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });

  function send(message) {
    child.stdin.write(encodeNativeMessage(message));
  }

  function nextMessage(timeoutMs = 5000) {
    if (received.length > 0) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onMessage);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for native host response (stderr: ${stderr})`));
      }, timeoutMs);
      function onMessage(message) {
        clearTimeout(timer);
        resolve(message);
      }
      waiters.push(onMessage);
    });
  }

  async function close() {
    child.stdin.end();
    return exitPromise;
  }

  return { send, nextMessage, close };
}

test('resolveDataFilePath honors env overrides and platform defaults', () => {
  assert.equal(
    resolveDataFilePath({ env: { MIAOJI_DATA_FILE: '/tmp/custom.json' }, platform: 'darwin', homeDir: '/Users/demo' }),
    path.resolve('/tmp/custom.json')
  );
  assert.equal(
    resolveDataFilePath({ env: { MIAOJI_DATA_DIR: '/tmp/miaoji-dir' }, platform: 'darwin', homeDir: '/Users/demo' }),
    path.join(path.resolve('/tmp/miaoji-dir'), 'user-data.json')
  );
  assert.equal(
    resolveDataFilePath({ env: {}, platform: 'darwin', homeDir: '/Users/demo' }),
    path.join('/Users/demo', '.config', 'miaoji', 'user-data.json')
  );
  assert.equal(
    resolveDataFilePath({ env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }, platform: 'win32', homeDir: 'C:\\Users\\demo' }),
    path.join('C:\\Users\\demo\\AppData\\Roaming', 'miaoji', 'user-data.json')
  );
});

test('native host supports chunked stdio roundtrip, atomic writes and rejects invalid payloads', async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'miaoji-native-host-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const host = startHostProcess(process.execPath, [HOST_SCRIPT], {
    MIAOJI_DATA_DIR: tempDir
  });

  // 1. Ping & read when file does not exist yet
  host.send({ type: 'ping', requestId: 'p1' });
  const pong = await host.nextMessage();
  assert.equal(pong.type, 'pong');
  assert.equal(pong.ok, true);
  assert.equal(pong.exists, false);
  assert.equal(pong.path, path.join(tempDir, 'user-data.json'));

  host.send({ type: 'read', requestId: 'r1' });
  const emptyRead = await host.nextMessage();
  assert.equal(emptyRead.type, 'read-end');
  assert.equal(emptyRead.exists, false);
  assert.equal(emptyRead.totalChunks, 0);

  // 2. Chunked write of a large (> 250 KiB) CJK payload
  const titles = {};
  for (let index = 0; index < 1800; index += 1) {
    titles[`https://docs.example.com/page/${index}`] = {
      title: `中文项目文档标题_${index}_${'数据持久化测试'.repeat(6)}`,
      targetUrl: `https://docs.example.com/page/${index}`,
      updatedAt: 1700000000000 + index
    };
  }
  const payload = {
    format: 'history-dedupe-user-data',
    version: 2,
    exportedAt: '2026-11-25T10:00:00.000Z',
    data: {
      'deduped-history-title-overrides': titles,
      'deduped-history-title-overrides-migration': 6,
      'deduped-history-group-name-overrides': { 'docs.example.com': '项目文档' },
      'deduped-history-pinned-urls': ['https://docs.example.com/page/0'],
      'deduped-history-captured-page-titles': {}
    }
  };
  const serialized = JSON.stringify(payload);
  const chunkSize = 80_000;
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += chunkSize) {
    chunks.push(serialized.slice(offset, offset + chunkSize));
  }
  assert.ok(chunks.length >= 3, 'payload should span multiple write chunks');

  host.send({ type: 'write-begin', requestId: 'w1' });
  assert.equal((await host.nextMessage()).type, 'write-ack');
  for (let index = 0; index < chunks.length; index += 1) {
    host.send({ type: 'write-chunk', requestId: 'w1', index, data: chunks[index] });
    const ack = await host.nextMessage();
    assert.equal(ack.type, 'write-ack');
    assert.equal(ack.index, index);
  }
  host.send({ type: 'write-commit', requestId: 'w1', totalChunks: chunks.length });
  const done = await host.nextMessage();
  assert.equal(done.type, 'write-done');
  assert.equal(done.ok, true);

  // Verify on-disk state, permissions, and no stray temp files
  const files = readdirSync(tempDir);
  assert.deepEqual(files, ['user-data.json']);
  if (process.platform !== 'win32') {
    const mode = statSync(path.join(tempDir, 'user-data.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  // 3. Chunked read back must match exactly
  host.send({ type: 'read', requestId: 'r2' });
  const readChunks = [];
  let readEnd;
  while (true) {
    const message = await host.nextMessage();
    if (message.type === 'read-chunk') {
      readChunks[message.index] = message.data;
    } else {
      readEnd = message;
      break;
    }
  }
  assert.equal(readEnd.type, 'read-end');
  assert.equal(readEnd.exists, true);
  assert.ok(readEnd.totalChunks >= 2, 'large file should stream in multiple read chunks');
  assert.deepEqual(JSON.parse(readChunks.join('')), payload);

  // 4. Reject invalid payload format without touching the valid file on disk
  host.send({ type: 'write-begin', requestId: 'w-bad' });
  assert.equal((await host.nextMessage()).type, 'write-ack');
  host.send({ type: 'write-chunk', requestId: 'w-bad', index: 0, data: JSON.stringify({ format: 'wrong' }) });
  assert.equal((await host.nextMessage()).type, 'write-ack');
  host.send({ type: 'write-commit', requestId: 'w-bad', totalChunks: 1 });
  const badResp = await host.nextMessage();
  assert.equal(badResp.type, 'error');
  assert.equal(badResp.code, 'INVALID_PAYLOAD');
  assert.deepEqual(JSON.parse(readFileSync(path.join(tempDir, 'user-data.json'), 'utf8')), payload);

  const exit = await host.close();
  assert.equal(exit.code, 0);
});

test('installNativeHost creates a repo-independent launcher and uninstall preserves user data', async (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'miaoji-install-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const installDir = path.join(tempRoot, 'config', 'miaoji', 'native-host');
  const browserManifestDir = path.join(tempRoot, 'chrome', 'NativeMessagingHosts');
  const dataDir = path.join(tempRoot, 'data');

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const expectedId = deriveExtensionIdFromPublicKey(manifest.key);
  assert.match(expectedId, /^[a-p]{32}$/);

  const installed = installNativeHost({
    manifestPath: MANIFEST_PATH,
    sourceHostPath: HOST_SCRIPT,
    env: { MIAOJI_DATA_DIR: dataDir },
    installDir,
    targetManifestDirs: [browserManifestDir]
  });

  assert.equal(installed.extensionId, expectedId);
  assert.equal(installed.hostName, NATIVE_HOST_NAME);
  assert.equal(existsSync(installed.launcherPath), true);
  assert.equal(existsSync(path.join(installDir, 'host.mjs')), true);

  const registeredManifestPath = path.join(browserManifestDir, `${NATIVE_HOST_NAME}.json`);
  const registeredManifest = JSON.parse(readFileSync(registeredManifestPath, 'utf8'));
  assert.equal(registeredManifest.name, NATIVE_HOST_NAME);
  assert.equal(registeredManifest.path, installed.launcherPath);
  assert.deepEqual(registeredManifest.allowed_origins, [`chrome-extension://${expectedId}/`]);

  // Execute the installed standalone launcher directly (independent of the repo path)
  if (process.platform !== 'win32') {
    const launcherHost = startHostProcess(installed.launcherPath, [], {
      MIAOJI_DATA_DIR: dataDir,
      PATH: '/usr/bin:/bin'
    });
    launcherHost.send({ type: 'ping', requestId: 'launcher-1' });
    const pong = await launcherHost.nextMessage();
    assert.equal(pong.ok, true);
    assert.equal(pong.path, path.join(dataDir, 'user-data.json'));
    const exit = await launcherHost.close();
    assert.equal(exit.code, 0);
  }

  // Create a user-data.json file and verify uninstall keeps it untouched
  mkdirSync(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, 'user-data.json');
  writeFileSync(dataFile, '{"format":"history-dedupe-user-data","version":2}\n', 'utf8');

  const uninstalled = uninstallNativeHost({
    env: { MIAOJI_DATA_DIR: dataDir },
    installDir,
    targetManifestDirs: [browserManifestDir]
  });
  assert.equal(uninstalled.hostName, NATIVE_HOST_NAME);
  assert.equal(existsSync(registeredManifestPath), false);
  assert.equal(existsSync(installDir), false);
  assert.equal(existsSync(dataFile), true);
});

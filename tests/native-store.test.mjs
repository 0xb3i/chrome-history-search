import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTURED_PAGE_TITLES_STORAGE_KEY as C,
  GROUP_NAME_OVERRIDES_STORAGE_KEY as G,
  PINNED_URLS_STORAGE_KEY as P,
  TITLE_OVERRIDES_MIGRATION_STORAGE_KEY as V,
  TITLE_OVERRIDES_STORAGE_KEY as T,
  deleteTitleOverrides,
  saveTitleOverride
} from '../src/storage.js';
import {
  NATIVE_STORE_BASELINE_STORAGE_KEY,
  createNativeStoreClient,
  createNativeStoreController
} from '../src/native-store.js';
import { createNativeStoreHandler } from '../native-host/host.mjs';

function setupChromeStorage(values = {}) {
  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get(key, callback) {
          setImmediate(() => callback({ [key]: structuredClone(values[key]) }));
        },
        set(next, callback) {
          setImmediate(() => {
            Object.assign(values, structuredClone(next));
            callback();
          });
        }
      }
    }
  };
  return values;
}

function createBackupText(data) {
  return JSON.stringify({
    format: 'history-dedupe-user-data',
    version: 2,
    exportedAt: '2026-11-25T10:00:00.000Z',
    data: {
      [T]: {},
      [V]: 6,
      [G]: {},
      [P]: [],
      [C]: {},
      ...data
    }
  });
}

function createFakeClient({ available = true, initialText = null, path = '/Users/demo/.config/miaoji/user-data.json' } = {}) {
  let fileText = initialText;
  const calls = [];
  return {
    calls,
    get fileText() { return fileText; },
    set fileText(next) { fileText = next; },
    async ping() {
      calls.push('ping');
      if (!available) return { available: false };
      return { available: true, path, exists: fileText !== null, updatedAt: 100 };
    },
    async read() {
      calls.push('read');
      if (!available) return { available: false };
      if (fileText === null) return { available: true, exists: false, path, updatedAt: 0, text: '' };
      return { available: true, exists: true, path, updatedAt: 100, text: fileText };
    },
    async write(backup) {
      calls.push('write');
      if (!available) return { available: false };
      fileText = JSON.stringify(backup);
      return { available: true, path, updatedAt: 200 };
    }
  };
}

test('createNativeStoreClient transfers chunked reads and writes cleanly and degrades when host is missing', async () => {
  let currentFile = null;
  const fakeHandler = createNativeStoreHandler({
    filePath: '/unused',
    chunkLength: 40,
    send() {}
  });
  void fakeHandler;

  // Test unavailable host
  let lastError;
  const missingClient = createNativeStoreClient({
    connectNative() {
      const listeners = { message: [], disconnect: [] };
      return {
        onMessage: { addListener: (fn) => listeners.message.push(fn), removeListener() {} },
        onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn), removeListener() {} },
        postMessage() {
          setImmediate(() => {
            lastError = { message: 'Specified native messaging host not found.' };
            for (const fn of listeners.disconnect) fn();
          });
        },
        disconnect() {}
      };
    },
    getLastError: () => lastError
  });
  assert.equal((await missingClient.ping()).available, false);
  assert.equal((await missingClient.read()).available, false);

  // Test chunked write and chunked read over a virtual port
  const portClient = createNativeStoreClient({
    chunkLength: 32,
    connectNative() {
      const listeners = { message: [], disconnect: [] };
      const pending = new Map();
      const emit = (msg) => setImmediate(() => {
        for (const fn of listeners.message) fn(msg);
      });
      return {
        onMessage: { addListener: (fn) => listeners.message.push(fn), removeListener() {} },
        onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn), removeListener() {} },
        disconnect() {},
        postMessage(msg) {
          if (msg.type === 'write-begin') {
            pending.set(msg.requestId, []);
            emit({ type: 'write-ack', requestId: msg.requestId, ok: true });
          } else if (msg.type === 'write-chunk') {
            pending.get(msg.requestId).push(msg.data);
            emit({ type: 'write-ack', requestId: msg.requestId, ok: true, index: msg.index });
          } else if (msg.type === 'write-commit') {
            currentFile = pending.get(msg.requestId).join('');
            emit({ type: 'write-done', requestId: msg.requestId, ok: true, path: '/tmp/user-data.json', updatedAt: 500 });
          } else if (msg.type === 'read') {
            const chunks = [];
            for (let i = 0; i < currentFile.length; i += 25) chunks.push(currentFile.slice(i, i + 25));
            chunks.forEach((data, index) => emit({ type: 'read-chunk', requestId: msg.requestId, index, data }));
            emit({ type: 'read-end', requestId: msg.requestId, ok: true, exists: true, path: '/tmp/user-data.json', totalChunks: chunks.length, updatedAt: 500 });
          }
        }
      };
    }
  });

  const payload = JSON.parse(createBackupText({
    [T]: { 'https://example.com/a': { title: '一个很长的中文自定义页面标题用于触发多片传输', targetUrl: 'https://example.com/a', updatedAt: 42 } }
  }));
  const writeResult = await portClient.write(payload);
  assert.equal(writeResult.available, true);
  const readResult = await portClient.read();
  assert.equal(readResult.exists, true);
  assert.deepEqual(JSON.parse(readResult.text), payload);
});

test('freshly reloaded extension restores existing renames from native file without overwriting it', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({
    initialText: createBackupText({
      [T]: { 'https://example.com/doc': { title: '季度复盘', targetUrl: 'https://example.com/doc', updatedAt: 100 } },
      [G]: { 'example.com': '团队文档' },
      [P]: ['https://example.com/doc']
    })
  });

  try {
    const controller = createNativeStoreController({ client, now: () => 1234 });
    const status = await controller.ensureHydrated();

    assert.equal(status.state, 'connected');
    assert.equal(values[T]['https://example.com/doc'].title, '季度复盘');
    assert.equal(values[G]['example.com'], '团队文档');
    assert.deepEqual(values[P], ['https://example.com/doc']);
    assert.ok(values[NATIVE_STORE_BASELINE_STORAGE_KEY]);
    assert.deepEqual(client.calls, ['read']);
  } finally {
    delete globalThis.chrome;
  }
});

test('editing before initial hydration completes merges remote renames instead of clobbering them', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({
    initialText: createBackupText({
      [T]: { 'https://example.com/old': { title: '历史重命名', targetUrl: 'https://example.com/old', updatedAt: 10 } }
    })
  });

  try {
    const controller = createNativeStoreController({ client });
    await saveTitleOverride('https://example.com/new', '刚改的新名字');
    await controller.flushPending();

    assert.equal(values[T]['https://example.com/old'].title, '历史重命名');
    assert.equal(values[T]['https://example.com/new'].title, '刚改的新名字');
    const saved = JSON.parse(client.fileText);
    assert.equal(saved.data[T]['https://example.com/old'].title, '历史重命名');
    assert.equal(saved.data[T]['https://example.com/new'].title, '刚改的新名字');
  } finally {
    delete globalThis.chrome;
  }
});

test('deleting a rename while worker is asleep propagates deletion instead of resurrecting it', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({
    initialText: createBackupText({
      [T]: {
        'https://example.com/keep': { title: '保留项', targetUrl: 'https://example.com/keep', updatedAt: 10 },
        'https://example.com/drop': { title: '待还原项', targetUrl: 'https://example.com/drop', updatedAt: 20 }
      }
    })
  });

  try {
    // Session 1: initial hydration establishes baseline
    const firstWorker = createNativeStoreController({ client });
    await firstWorker.ensureHydrated();
    assert.equal(values[T]['https://example.com/drop'].title, '待还原项');

    // Popup deletes one rename while service worker is dormant
    await deleteTitleOverrides(['https://example.com/drop']);

    // Session 2: new service worker wakes up and calls ensureHydrated
    const wokenWorker = createNativeStoreController({ client });
    await wokenWorker.ensureHydrated();

    assert.equal(values[T]['https://example.com/drop'], undefined);
    assert.equal(values[T]['https://example.com/keep'].title, '保留项');
    const persisted = JSON.parse(client.fileText);
    assert.equal(persisted.data[T]['https://example.com/drop'], undefined);
    assert.equal(persisted.data[T]['https://example.com/keep'].title, '保留项');
  } finally {
    delete globalThis.chrome;
  }
});

test('seeding a new native file writes existing local renames on first enable', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({ initialText: null });

  try {
    await saveTitleOverride('https://example.com/local', '本地已有名称');
    const controller = createNativeStoreController({ client });
    const status = await controller.ensureHydrated();

    assert.equal(status.state, 'connected');
    assert.equal(status.exists, true);
    const persisted = JSON.parse(client.fileText);
    assert.equal(persisted.data[T]['https://example.com/local'].title, '本地已有名称');
  } finally {
    delete globalThis.chrome;
  }
});

test('corrupted native file pauses automatic writes until fixed and synced again', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({ initialText: '{corrupted json' });

  try {
    const controller = createNativeStoreController({ client });
    const status = await controller.ensureHydrated();
    assert.equal(status.state, 'error');
    assert.match(status.error, /格式异常/);

    await saveTitleOverride('https://example.com/a', '新修改');
    await controller.flushPending();
    assert.equal(client.fileText, '{corrupted json');
    assert.equal(client.calls.includes('write'), false);

    // After user repairs the file, manual sync resumes cleanly
    client.fileText = createBackupText({
      [T]: { 'https://example.com/repaired': { title: '修复后的记录', targetUrl: 'https://example.com/repaired', updatedAt: 50 } }
    });
    const recovered = await controller.syncNow();
    assert.equal(recovered.state, 'connected');
    assert.equal(values[T]['https://example.com/repaired'].title, '修复后的记录');
    assert.equal(values[T]['https://example.com/a'].title, '新修改');
  } finally {
    delete globalThis.chrome;
  }
});

test('high priority rename upgrades a pending slow captured-title flush timer', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({ initialText: null });
  const scheduled = [];
  let timerSeq = 0;

  try {
    const controller = createNativeStoreController({
      client,
      highPriorityDelayMs: 100,
      lowPriorityDelayMs: 1500,
      setTimeoutFn(fn, delay) {
        const id = ++timerSeq;
        scheduled.push({ id, fn, delay, cleared: false });
        return id;
      },
      clearTimeoutFn(id) {
        const entry = scheduled.find((item) => item.id === id);
        if (entry) entry.cleared = true;
      }
    });

    await controller.ensureHydrated();
    controller.handleStorageChanged({ [C]: { newValue: {} } }, 'local');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 1500);

    controller.handleStorageChanged({ [T]: { newValue: {} } }, 'local');
    assert.equal(scheduled[0].cleared, true);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].delay, 100);
  } finally {
    delete globalThis.chrome;
  }
});

test('unavailable native host degrades silently without touching baseline or failing writes', async () => {
  const values = setupChromeStorage({});
  const client = createFakeClient({ available: false });

  try {
    const controller = createNativeStoreController({ client });
    const status = await controller.ensureHydrated();
    assert.equal(status.state, 'unavailable');
    assert.equal(values[NATIVE_STORE_BASELINE_STORAGE_KEY], undefined);
    await saveTitleOverride('https://example.com/offline', '离线名称');
    const pushStatus = await controller.flushPending();
    assert.equal(pushStatus.state, 'unavailable');
    assert.equal(values[T]['https://example.com/offline'].title, '离线名称');
  } finally {
    delete globalThis.chrome;
  }
});

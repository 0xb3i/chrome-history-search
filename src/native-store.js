import {
  CAPTURED_PAGE_TITLES_STORAGE_KEY,
  GROUP_NAME_OVERRIDES_STORAGE_KEY,
  PINNED_URLS_STORAGE_KEY,
  TITLE_OVERRIDES_STORAGE_KEY,
  mergeUserDataFromBackup,
  readUserDataForBackup
} from './storage.js';
import {
  createUserDataBackupPayload,
  validateUserDataBackup
} from './user-data-backup.js';

export const NATIVE_STORE_HOST_NAME = 'io.github.miaoji.local_store';
export const NATIVE_STORE_STATUS_MESSAGE = 'deduped-history:native-store-status';
export const NATIVE_STORE_SYNC_MESSAGE = 'deduped-history:native-store-sync';
export const NATIVE_STORE_BASELINE_STORAGE_KEY = 'deduped-history-native-store-baseline';

const WRITE_CHUNK_CHAR_LENGTH = 200_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HIGH_PRIORITY_FLUSH_DELAY_MS = 100;
const LOW_PRIORITY_FLUSH_DELAY_MS = 1500;

const HIGH_PRIORITY_USER_DATA_KEYS = new Set([
  TITLE_OVERRIDES_STORAGE_KEY,
  GROUP_NAME_OVERRIDES_STORAGE_KEY,
  PINNED_URLS_STORAGE_KEY
]);
const USER_DATA_STORAGE_KEYS = new Set([
  ...HIGH_PRIORITY_USER_DATA_KEYS,
  CAPTURED_PAGE_TITLES_STORAGE_KEY
]);

export function createNativeStoreClient({
  hostName = NATIVE_STORE_HOST_NAME,
  connectNative = defaultConnectNative,
  getLastError = defaultGetLastError,
  chunkLength = WRITE_CHUNK_CHAR_LENGTH,
  timeoutMs = REQUEST_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
} = {}) {
  let nextRequestId = 0;

  function createRequestId(prefix) {
    nextRequestId += 1;
    return `${prefix}-${Date.now()}-${nextRequestId}`;
  }

  function openSession(executor) {
    if (typeof connectNative !== 'function') {
      return Promise.resolve({ available: false, reason: 'unavailable' });
    }

    let port;
    try {
      port = connectNative(hostName);
    } catch (error) {
      if (isUnavailableHostError(error?.message)) {
        return Promise.resolve({ available: false, reason: error.message });
      }
      return Promise.reject(error);
    }

    if (!port) {
      return Promise.resolve({ available: false, reason: 'unavailable' });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      function cleanup() {
        if (timer !== null) {
          clearTimeoutFn(timer);
          timer = null;
        }
        try { port.onMessage?.removeListener?.(onMessage); } catch {}
        try { port.onDisconnect?.removeListener?.(onDisconnect); } catch {}
        try { port.disconnect?.(); } catch {}
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      const handlers = executor({ port, finish, fail });

      function onMessage(message) {
        if (settled) return;
        try {
          handlers.onMessage(message);
        } catch (error) {
          fail(error);
        }
      }

      function onDisconnect() {
        if (settled) return;
        const message = getLastError()?.message || '';
        if (handlers.onDisconnect) {
          handlers.onDisconnect(message);
          return;
        }
        if (isUnavailableHostError(message) || !message) {
          finish({ available: false, reason: message || 'disconnected' });
          return;
        }
        fail(new Error(message));
      }

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      timer = setTimeoutFn(() => {
        fail(new Error('本机同步服务响应超时。'));
      }, timeoutMs);

      try {
        handlers.start();
      } catch (error) {
        fail(error);
      }
    });
  }

  return {
    ping() {
      const requestId = createRequestId('ping');
      return openSession(({ port, finish, fail }) => ({
        start() {
          port.postMessage({ type: 'ping', requestId });
        },
        onMessage(message) {
          if (message?.requestId !== requestId) return;
          if (message.type === 'pong' && message.ok) {
            finish({
              available: true,
              path: String(message.path ?? ''),
              exists: Boolean(message.exists),
              updatedAt: Number(message.updatedAt ?? 0),
              hostVersion: Number(message.hostVersion ?? 0)
            });
            return;
          }
          if (message.type === 'error') {
            fail(createHostError(message));
          }
        }
      }));
    },

    read() {
      const requestId = createRequestId('read');
      const chunks = [];

      return openSession(({ port, finish, fail }) => ({
        start() {
          port.postMessage({ type: 'read', requestId });
        },
        onMessage(message) {
          if (message?.requestId !== requestId) return;
          if (message.type === 'read-chunk') {
            if (message.index !== chunks.length || typeof message.data !== 'string') {
              fail(new Error('本机同步数据分片顺序异常。'));
              return;
            }
            chunks.push(message.data);
            return;
          }
          if (message.type === 'read-end' && message.ok) {
            const totalChunks = Number(message.totalChunks ?? 0);
            if (chunks.length !== totalChunks) {
              fail(new Error('本机同步数据分片不完整。'));
              return;
            }
            finish({
              available: true,
              exists: Boolean(message.exists),
              path: String(message.path ?? ''),
              updatedAt: Number(message.updatedAt ?? 0),
              text: message.exists ? chunks.join('') : ''
            });
            return;
          }
          if (message.type === 'error') {
            fail(createHostError(message));
          }
        }
      }));
    },

    write(backup) {
      const requestId = createRequestId('write');
      const serialized = JSON.stringify(backup);
      const chunks = splitTextChunks(serialized, chunkLength);
      let nextChunkIndex = 0;
      let phase = 'begin';

      return openSession(({ port, finish, fail }) => ({
        start() {
          port.postMessage({ type: 'write-begin', requestId });
        },
        onMessage(message) {
          if (message?.requestId !== requestId) return;
          if (message.type === 'error') {
            fail(createHostError(message));
            return;
          }
          if (message.type === 'write-ack' && message.ok) {
            if (phase === 'begin' || phase === 'chunks') {
              if (nextChunkIndex < chunks.length) {
                phase = 'chunks';
                const index = nextChunkIndex;
                nextChunkIndex += 1;
                port.postMessage({
                  type: 'write-chunk',
                  requestId,
                  index,
                  data: chunks[index]
                });
              } else {
                phase = 'commit';
                port.postMessage({
                  type: 'write-commit',
                  requestId,
                  totalChunks: chunks.length
                });
              }
            }
            return;
          }
          if (message.type === 'write-done' && message.ok) {
            finish({
              available: true,
              path: String(message.path ?? ''),
              updatedAt: Number(message.updatedAt ?? Date.now())
            });
          }
        }
      }));
    }
  };
}

export function createNativeStoreController({
  client = createNativeStoreClient(),
  readLocalUserData = readUserDataForBackup,
  mergeLocalUserData = mergeUserDataFromBackup,
  readBaseline = readStoredBaseline,
  writeBaseline = writeStoredBaseline,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  now = () => Date.now(),
  highPriorityDelayMs = HIGH_PRIORITY_FLUSH_DELAY_MS,
  lowPriorityDelayMs = LOW_PRIORITY_FLUSH_DELAY_MS
} = {}) {
  let queue = Promise.resolve();
  let flushTimer = null;
  let flushDelayMs = null;
  let lastWrittenFingerprint = '';
  let fileCorrupted = false;
  let status = {
    state: 'unknown',
    path: '',
    exists: false,
    lastSyncedAt: 0,
    error: ''
  };

  function snapshotStatus() {
    return { ...status };
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function setStatus(next) {
    status = {
      state: next.state ?? status.state,
      path: next.path ?? status.path,
      exists: Boolean(next.exists ?? status.exists),
      lastSyncedAt: Number(next.lastSyncedAt ?? status.lastSyncedAt),
      error: String(next.error ?? '')
    };
    return snapshotStatus();
  }

  async function writeLocalSnapshot(localData, localFingerprint, fallbackPath = '') {
    try {
      const writeResult = await client.write(createUserDataBackupPayload(localData));
      if (!writeResult?.available) {
        return setStatus({
          state: 'unavailable',
          path: '',
          exists: false,
          error: ''
        });
      }
      lastWrittenFingerprint = localFingerprint;
      const syncedAt = now();
      const filePath = writeResult.path || fallbackPath || status.path;
      await writeBaseline({ syncedAt, path: filePath, fingerprint: localFingerprint });
      return setStatus({
        state: 'connected',
        path: filePath,
        exists: true,
        lastSyncedAt: syncedAt,
        error: ''
      });
    } catch (error) {
      return setStatus({
        state: 'error',
        path: error?.path || fallbackPath || status.path,
        error: error?.message || '写入本机数据文件失败。'
      });
    }
  }

  async function performBidirectionalSync() {
    let readResult;
    try {
      readResult = await client.read();
    } catch (error) {
      return setStatus({
        state: 'error',
        path: error?.path || status.path,
        error: error?.message || '读取本机数据文件失败。'
      });
    }

    if (!readResult?.available) {
      return setStatus({
        state: 'unavailable',
        path: '',
        exists: false,
        error: ''
      });
    }

    const filePath = readResult.path || status.path;

    if (readResult.exists) {
      let parsed;
      try {
        parsed = JSON.parse(readResult.text);
        validateUserDataBackup(parsed);
      } catch {
        // Never overwrite a damaged file automatically; let the user inspect or repair it.
        fileCorrupted = true;
        return setStatus({
          state: 'error',
          path: filePath,
          exists: true,
          error: '本机数据文件格式异常，已暂停自动写入。'
        });
      }

      fileCorrupted = false;
      await mergeLocalUserData(parsed.data);
      const mergedData = await readLocalUserData();
      const mergedFingerprint = canonicalizeUserData(mergedData);
      const remoteFingerprint = canonicalizeUserData(parsed.data);

      if (mergedFingerprint !== remoteFingerprint) {
        return writeLocalSnapshot(mergedData, mergedFingerprint, filePath);
      }

      lastWrittenFingerprint = mergedFingerprint;
      const syncedAt = now();
      await writeBaseline({ syncedAt, path: filePath, fingerprint: mergedFingerprint });
      return setStatus({
        state: 'connected',
        path: filePath,
        exists: true,
        lastSyncedAt: syncedAt,
        error: ''
      });
    }

    // Native file does not exist yet: seed it if local storage already has user data.
    fileCorrupted = false;
    const localData = await readLocalUserData();
    const localFingerprint = canonicalizeUserData(localData);

    if (hasAnyUserData(localData)) {
      return writeLocalSnapshot(localData, localFingerprint, filePath);
    }

    lastWrittenFingerprint = localFingerprint;
    const syncedAt = now();
    await writeBaseline({ syncedAt, path: filePath, fingerprint: localFingerprint });
    return setStatus({
      state: 'connected',
      path: filePath,
      exists: false,
      lastSyncedAt: syncedAt,
      error: ''
    });
  }

  async function performStartupHydration() {
    const baseline = await readBaseline();
    if (!baseline) {
      return performBidirectionalSync();
    }

    // After a service worker wakeup in an already-hydrated installation, do not
    // blindly merge old file entries back over a fresh local deletion.
    if (!lastWrittenFingerprint && typeof baseline.fingerprint === 'string') {
      lastWrittenFingerprint = baseline.fingerprint;
    }

    const localData = await readLocalUserData();
    const localFingerprint = canonicalizeUserData(localData);
    if (localFingerprint !== lastWrittenFingerprint && hasAnyUserData(localData)) {
      return writeLocalSnapshot(localData, localFingerprint, baseline.path);
    }
    if (localFingerprint !== lastWrittenFingerprint && baseline.fingerprint) {
      return writeLocalSnapshot(localData, localFingerprint, baseline.path);
    }

    let pingResult;
    try {
      pingResult = await client.ping();
    } catch (error) {
      return setStatus({
        state: 'error',
        path: error?.path || baseline.path || status.path,
        error: error?.message || '连接本机同步服务失败。'
      });
    }

    if (!pingResult?.available) {
      return setStatus({
        state: 'unavailable',
        path: '',
        exists: false,
        error: ''
      });
    }

    return setStatus({
      state: 'connected',
      path: pingResult.path || baseline.path || status.path,
      exists: pingResult.exists,
      lastSyncedAt: Number(baseline.syncedAt || status.lastSyncedAt || pingResult.updatedAt || 0),
      error: ''
    });
  }

  async function performPush() {
    if (fileCorrupted) {
      return snapshotStatus();
    }

    const baseline = await readBaseline();
    if (!baseline) {
      // A freshly installed or reloaded extension must merge from the native file
      // before it is ever allowed to overwrite it.
      return performBidirectionalSync();
    }

    if (!lastWrittenFingerprint && typeof baseline.fingerprint === 'string') {
      lastWrittenFingerprint = baseline.fingerprint;
    }

    const localData = await readLocalUserData();
    const localFingerprint = canonicalizeUserData(localData);
    if (localFingerprint === lastWrittenFingerprint) {
      return snapshotStatus();
    }

    if (!status.exists && !baseline.fingerprint && !hasAnyUserData(localData)) {
      lastWrittenFingerprint = localFingerprint;
      return snapshotStatus();
    }

    return writeLocalSnapshot(localData, localFingerprint, baseline.path);
  }

  function schedulePush(delayMs) {
    if (flushTimer !== null) {
      if (flushDelayMs !== null && flushDelayMs <= delayMs) {
        return;
      }
      clearTimeoutFn(flushTimer);
      flushTimer = null;
      flushDelayMs = null;
    }

    flushDelayMs = delayMs;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      flushDelayMs = null;
      void enqueue(performPush).catch(() => {});
    }, delayMs);
  }

  return {
    ensureHydrated() {
      return enqueue(performStartupHydration);
    },

    syncNow() {
      if (flushTimer !== null) {
        clearTimeoutFn(flushTimer);
        flushTimer = null;
        flushDelayMs = null;
      }
      return enqueue(async () => {
        const baseline = await readBaseline();
        if (baseline && !fileCorrupted) {
          const localData = await readLocalUserData();
          const localFingerprint = canonicalizeUserData(localData);
          const knownFingerprint = lastWrittenFingerprint || baseline.fingerprint || '';
          if (knownFingerprint && localFingerprint !== knownFingerprint) {
            return writeLocalSnapshot(localData, localFingerprint, baseline.path);
          }
        }
        return performBidirectionalSync();
      });
    },

    getStatus() {
      return enqueue(async () => {
        if (status.state === 'unknown' || status.state === 'unavailable') {
          return performStartupHydration();
        }
        return snapshotStatus();
      });
    },

    handleStorageChanged(changes, areaName) {
      if (areaName !== 'local' || !changes || typeof changes !== 'object') {
        return;
      }
      let hasUserDataChange = false;
      let isHighPriority = false;
      for (const key of Object.keys(changes)) {
        if (USER_DATA_STORAGE_KEYS.has(key)) {
          hasUserDataChange = true;
          if (HIGH_PRIORITY_USER_DATA_KEYS.has(key)) {
            isHighPriority = true;
          }
        }
      }
      if (!hasUserDataChange) {
        return;
      }
      schedulePush(isHighPriority ? highPriorityDelayMs : lowPriorityDelayMs);
    },

    flushPending() {
      if (flushTimer !== null) {
        clearTimeoutFn(flushTimer);
        flushTimer = null;
        flushDelayMs = null;
      }
      return enqueue(performPush);
    }
  };
}

export function hasAnyUserData(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    Object.keys(data[TITLE_OVERRIDES_STORAGE_KEY] ?? {}).length > 0 ||
    Object.keys(data[GROUP_NAME_OVERRIDES_STORAGE_KEY] ?? {}).length > 0 ||
    (Array.isArray(data[PINNED_URLS_STORAGE_KEY]) && data[PINNED_URLS_STORAGE_KEY].length > 0) ||
    Object.keys(data[CAPTURED_PAGE_TITLES_STORAGE_KEY] ?? {}).length > 0
  );
}

function canonicalizeUserData(data) {
  return JSON.stringify(sortObjectKeys(data ?? {}));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObjectKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

function splitTextChunks(text, chunkLength) {
  if (!text) return [];
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkLength) {
    chunks.push(text.slice(offset, offset + chunkLength));
  }
  return chunks;
}

function createHostError(message) {
  const error = new Error(message?.error || '本机同步服务返回错误。');
  error.code = message?.code || 'HOST_ERROR';
  error.path = String(message?.path ?? '');
  return error;
}

function isUnavailableHostError(message) {
  const normalized = String(message ?? '').toLowerCase();
  return (
    normalized.includes('native messaging host not found') ||
    normalized.includes('specified native messaging host') ||
    normalized.includes('forbidden') ||
    normalized.includes('not installed')
  );
}

function defaultConnectNative(hostName) {
  return globalThis.chrome?.runtime?.connectNative?.(hostName);
}

function defaultGetLastError() {
  return globalThis.chrome?.runtime?.lastError;
}

function readStoredBaseline() {
  const storageArea = globalThis.chrome?.storage?.local;
  if (!storageArea?.get) return Promise.resolve(null);
  return new Promise((resolve) => {
    storageArea.get(NATIVE_STORE_BASELINE_STORAGE_KEY, (items) => {
      if (globalThis.chrome?.runtime?.lastError) {
        resolve(null);
        return;
      }
      resolve(items?.[NATIVE_STORE_BASELINE_STORAGE_KEY] ?? null);
    });
  });
}

function writeStoredBaseline(value) {
  const storageArea = globalThis.chrome?.storage?.local;
  if (!storageArea?.set) return Promise.resolve();
  return new Promise((resolve) => {
    storageArea.set({ [NATIVE_STORE_BASELINE_STORAGE_KEY]: value }, () => {
      void globalThis.chrome?.runtime?.lastError;
      resolve();
    });
  });
}

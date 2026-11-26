import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_HOST_NAME = 'io.github.miaoji.local_store';
export const NATIVE_HOST_VERSION = 1;
// Keep every stdout message comfortably below Chrome's 1 MiB native messaging limit
// even when all characters are 3-byte UTF-8 CJK glyphs.
export const READ_CHUNK_CHAR_LENGTH = 200_000;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const BACKUP_FORMAT = 'history-dedupe-user-data';

export function resolveDataFilePath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir()
} = {}) {
  const explicitFile = String(env.MIAOJI_DATA_FILE ?? '').trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const explicitDir = String(env.MIAOJI_DATA_DIR ?? '').trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), 'user-data.json');
  }

  if (platform === 'win32') {
    const appData = String(env.APPDATA ?? '').trim() || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'miaoji', 'user-data.json');
  }

  const configRoot = String(env.XDG_CONFIG_HOME ?? '').trim() || path.join(homeDir, '.config');
  return path.join(configRoot, 'miaoji', 'user-data.json');
}

export function encodeNativeMessage(message, endianness = os.endianness()) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  if (endianness === 'BE') header.writeUInt32BE(payload.length, 0);
  else header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function createNativeMessageParser(onMessage, { endianness = os.endianness() } = {}) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = endianness === 'BE' ? buffer.readUInt32BE(0) : buffer.readUInt32LE(0);
      if (length > MAX_WRITE_BYTES) {
        throw new Error(`Native message exceeds size limit (${length} bytes)`);
      }
      if (buffer.length < 4 + length) {
        break;
      }

      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(body));
    }
  };
}

export function createNativeStoreHandler({
  filePath = resolveDataFilePath(),
  platform = process.platform,
  chunkLength = READ_CHUNK_CHAR_LENGTH,
  send
} = {}) {
  const pendingWrites = new Map();

  function reply(message) {
    send(message);
  }

  function handleMessage(message) {
    const requestId = String(message?.requestId ?? '');
    const type = String(message?.type ?? '');

    try {
      if (type === 'ping') {
        const exists = existsSync(filePath);
        const updatedAt = exists ? Math.round(statSync(filePath).mtimeMs) : 0;
        reply({
          type: 'pong',
          requestId,
          ok: true,
          path: filePath,
          exists,
          updatedAt,
          hostVersion: NATIVE_HOST_VERSION
        });
        return;
      }

      if (type === 'read') {
        if (!existsSync(filePath)) {
          reply({
            type: 'read-end',
            requestId,
            ok: true,
            exists: false,
            path: filePath,
            totalChunks: 0,
            updatedAt: 0
          });
          return;
        }

        const content = readFileSync(filePath, 'utf8');
        const updatedAt = Math.round(statSync(filePath).mtimeMs);
        const chunks = splitTextChunks(content, chunkLength);
        chunks.forEach((data, index) => {
          reply({
            type: 'read-chunk',
            requestId,
            index,
            data
          });
        });
        reply({
          type: 'read-end',
          requestId,
          ok: true,
          exists: true,
          path: filePath,
          totalChunks: chunks.length,
          updatedAt
        });
        return;
      }

      if (type === 'write-begin') {
        pendingWrites.set(requestId, { chunks: [], bytes: 0 });
        reply({ type: 'write-ack', requestId, ok: true });
        return;
      }

      if (type === 'write-chunk') {
        const session = pendingWrites.get(requestId);
        const index = Number(message?.index);
        const data = typeof message?.data === 'string' ? message.data : null;
        if (!session || !Number.isInteger(index) || index !== session.chunks.length || data === null) {
          pendingWrites.delete(requestId);
          reply({
            type: 'error',
            requestId,
            ok: false,
            code: 'INVALID_WRITE_CHUNK',
            error: '写入分片顺序无效。',
            path: filePath
          });
          return;
        }

        session.bytes += Buffer.byteLength(data, 'utf8');
        if (session.bytes > MAX_WRITE_BYTES) {
          pendingWrites.delete(requestId);
          reply({
            type: 'error',
            requestId,
            ok: false,
            code: 'PAYLOAD_TOO_LARGE',
            error: '待写入数据超过体积上限。',
            path: filePath
          });
          return;
        }

        session.chunks.push(data);
        reply({ type: 'write-ack', requestId, ok: true, index });
        return;
      }

      if (type === 'write-commit') {
        const session = pendingWrites.get(requestId);
        pendingWrites.delete(requestId);
        const totalChunks = Number(message?.totalChunks);
        if (!session || !Number.isInteger(totalChunks) || session.chunks.length !== totalChunks) {
          reply({
            type: 'error',
            requestId,
            ok: false,
            code: 'INCOMPLETE_WRITE',
            error: '写入分片不完整，未修改本机文件。',
            path: filePath
          });
          return;
        }

        const content = session.chunks.join('');
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          reply({
            type: 'error',
            requestId,
            ok: false,
            code: 'INVALID_JSON',
            error: '待写入数据不是有效 JSON，未修改本机文件。',
            path: filePath
          });
          return;
        }

        if (!parsed || typeof parsed !== 'object' || parsed.format !== BACKUP_FORMAT) {
          reply({
            type: 'error',
            requestId,
            ok: false,
            code: 'INVALID_PAYLOAD',
            error: '待写入数据格式无效，未修改本机文件。',
            path: filePath
          });
          return;
        }

        const updatedAt = writeFileAtomically(filePath, `${JSON.stringify(parsed, null, 2)}\n`, platform);
        reply({
          type: 'write-done',
          requestId,
          ok: true,
          path: filePath,
          updatedAt
        });
        return;
      }

      reply({
        type: 'error',
        requestId,
        ok: false,
        code: 'UNKNOWN_MESSAGE',
        error: `未知请求类型：${type || '(empty)'}`,
        path: filePath
      });
    } catch (error) {
      reply({
        type: 'error',
        requestId,
        ok: false,
        code: error?.code || 'HOST_ERROR',
        error: error?.message || '本机存储操作失败。',
        path: filePath
      });
    }
  }

  return { handleMessage };
}

function splitTextChunks(text, chunkLength) {
  if (!text) return [];
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkLength) {
    chunks.push(text.slice(offset, offset + chunkLength));
  }
  return chunks;
}

function writeFileAtomically(filePath, content, platform) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
    if (platform !== 'win32') {
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // Best effort permission tightening on POSIX file systems.
      }
    }
    return Math.round(statSync(filePath).mtimeMs);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures after a write error.
    }
    throw error;
  }
}

function startStdioHost() {
  const handler = createNativeStoreHandler({
    filePath: resolveDataFilePath(),
    send(message) {
      process.stdout.write(encodeNativeMessage(message));
    }
  });
  const feed = createNativeMessageParser((message) => {
    handler.handleMessage(message);
  });

  process.stdin.on('data', (chunk) => {
    try {
      feed(chunk);
    } catch (error) {
      process.stderr.write(`miaoji native host protocol error: ${error?.message || error}\n`);
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  startStdioHost();
}

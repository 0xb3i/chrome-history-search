import { exportUserDataBackup, importUserDataBackup } from './user-data-backup.js';
import {
  NATIVE_STORE_STATUS_MESSAGE,
  NATIVE_STORE_SYNC_MESSAGE
} from './native-store.js';

const NATIVE_STORE_INSTALL_COMMAND = 'npm run local-store:install';

export function initializeUserDataControls(document) {
  const controls = document.querySelector('#user-data-controls');
  if (controls) {
    initializeBackupButtons(document, controls);
  }
  initializeNativeStoreControls(document);
}

function initializeBackupButtons(document, controls) {
  const exportButton = controls.querySelector('#export-user-data');
  const importButton = controls.querySelector('#import-user-data');
  const fileInput = controls.querySelector('#user-data-file');
  const status = document.querySelector('#user-data-status');
  let busy = false;

  function setBusy(value) {
    busy = value;
    controls.setAttribute('aria-busy', String(value));
    exportButton.disabled = value;
    importButton.disabled = value;
    fileInput.disabled = value;
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
    status.hidden = false;
  }

  exportButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    showStatus('正在生成备份');
    try {
      const backup = await exportUserDataBackup();
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const date = new Date();
      const dateLabel = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((value) => String(value).padStart(2, '0')).join('-');
      link.href = url;
      link.download = `history-dedupe-backup-${dateLabel}.json`;
      link.hidden = true;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Keep the blob alive until the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      showStatus('已发起备份下载，包含收藏、自动采集标题、分组名称和置顶。');
    } catch (error) {
      showStatus(`备份失败：${error.message || '请重试。'}`, true);
    } finally {
      setBusy(false);
    }
  });

  importButton.addEventListener('click', () => {
    if (!busy) fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    showStatus('正在恢复备份');
    try {
      const text = await file.text();
      let backup;
      try {
        backup = JSON.parse(text);
      } catch {
        throw new Error('备份文件不是有效的 JSON。');
      }
      const counts = await importUserDataBackup(backup);
      showStatus(`恢复完成：现有 ${counts.titles} 条收藏、${counts.groups} 个分组名称、${counts.pins} 条置顶、${counts.capturedTitles} 条自动采集标题。已有内容已保留。`);
    } catch (error) {
      showStatus(`恢复失败：${error.message || '请检查备份文件后重试。'}`, true);
    } finally {
      fileInput.value = '';
      setBusy(false);
    }
  });
}

function initializeNativeStoreControls(document) {
  const row = document.querySelector('#native-store-row');
  if (!row) return;

  const detail = row.querySelector('#native-store-detail');
  const controls = row.querySelector('#native-store-controls');
  const copyButton = row.querySelector('#copy-native-store-command');
  const syncButton = row.querySelector('#sync-native-store');
  if (!detail || !controls || !copyButton || !syncButton) return;

  let busy = false;
  let currentState = 'unknown';
  let copyResetTimer = null;

  function setBusy(value, activeLabel = '同步中') {
    busy = value;
    controls.setAttribute('aria-busy', String(value));
    syncButton.disabled = value;
    copyButton.disabled = value;
    if (value) {
      syncButton.textContent = activeLabel;
    }
  }

  function renderStatus(status) {
    currentState = status?.state || 'unavailable';
    detail.dataset.error = String(currentState === 'error');
    if (status?.path) detail.title = status.path;
    else detail.removeAttribute('title');

    if (currentState === 'connected') {
      detail.textContent = status.path
        ? `已开启，自动保存到 ${status.path}`
        : '已开启，自动保存到本机文件';
      copyButton.hidden = true;
      syncButton.textContent = '立即同步';
      return;
    }

    if (currentState === 'error') {
      detail.textContent = status.error || '本机同步发生错误，请检查本机数据文件。';
      copyButton.hidden = true;
      syncButton.textContent = '重试同步';
      return;
    }

    detail.textContent = `未开启，在项目目录运行 ${NATIVE_STORE_INSTALL_COMMAND} 后自动同步`;
    copyButton.hidden = false;
    syncButton.textContent = '重新检测';
  }

  async function requestNativeStore(type) {
    const response = await sendRuntimeMessage({ type });
    if (!response?.ok) {
      return {
        state: 'error',
        path: '',
        error: response?.error || '无法读取本机同步状态。'
      };
    }
    return response.status;
  }

  async function refresh(type, activeLabel) {
    if (busy) return;
    setBusy(true, activeLabel);
    try {
      const status = await requestNativeStore(type);
      renderStatus(status);
    } catch {
      renderStatus({ state: 'unavailable', path: '', error: '' });
    } finally {
      setBusy(false);
    }
  }

  syncButton.addEventListener('click', () => {
    const label = currentState === 'connected' ? '同步中' : '检测中';
    void refresh(NATIVE_STORE_SYNC_MESSAGE, label);
  });

  copyButton.addEventListener('click', async () => {
    if (busy) return;
    const writeText = globalThis.navigator?.clipboard?.writeText;
    if (typeof writeText !== 'function') return;
    try {
      await writeText.call(globalThis.navigator.clipboard, NATIVE_STORE_INSTALL_COMMAND);
      copyButton.textContent = '已复制';
      if (copyResetTimer !== null) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyResetTimer = null;
        copyButton.textContent = '复制命令';
      }, 1500);
    } catch {
      copyButton.textContent = '复制失败';
    }
  });

  const view = document.defaultView;
  view?.addEventListener?.('focus', () => {
    if (currentState !== 'connected') {
      void refresh(NATIVE_STORE_STATUS_MESSAGE, '检测中');
    }
  });

  if (globalThis.chrome?.runtime?.sendMessage) {
    void refresh(NATIVE_STORE_STATUS_MESSAGE, '检测中');
  } else {
    renderStatus({ state: 'unavailable', path: '', error: '' });
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    const sendMessage = globalThis.chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') {
      resolve({ ok: true, status: { state: 'unavailable', path: '', error: '' } });
      return;
    }
    try {
      sendMessage(message, (response) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

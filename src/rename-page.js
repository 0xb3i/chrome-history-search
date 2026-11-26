import {
  deleteRenameDraft,
  deleteTitleOverrides,
  loadRenameDraft,
  loadTitleOverrides,
  saveTitleOverride
} from './storage.js';
import { observeContentWindowHeight } from './window-placement.js';
import { getHistoryItemSourceLabel } from './history-utils.js';
import { applySavedTheme } from './theme.js';

const form = document.querySelector('#rename-form');
const headingLabel = document.querySelector('#rename-heading');
const titleInput = document.querySelector('#rename-title');
const statusLabel = document.querySelector('#rename-status');
const urlLabel = document.querySelector('#rename-url');
const cancelButton = document.querySelector('#cancel-button');
const restoreButton = document.querySelector('#restore-button');

const stopFittingWindow = observeContentWindowHeight(form);
globalThis.addEventListener('pagehide', stopFittingWindow, { once: true });

applySavedTheme(document);

let currentDraft = null;
let canRestoreOriginalTitle = false;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveRename();
});

cancelButton.addEventListener('click', () => {
  closeWindow();
});

restoreButton.addEventListener('click', () => {
  restoreOriginalTitle();
});

titleInput.addEventListener('input', () => setPending(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !titleInput.disabled) closeWindow();
});

init();

async function init() {
  const draftId = new URLSearchParams(globalThis.location.search).get('draft');

  if (!draftId) {
    renderError('没有找到要收藏的网页。');
    return;
  }

  try {
    currentDraft = await loadRenameDraft(draftId);

    if (!currentDraft) {
      renderError('收藏窗口已过期，请重新按快捷键。');
      return;
    }

    titleInput.value = currentDraft.currentTitle;
    urlLabel.textContent = getHistoryItemSourceLabel(currentDraft);
    urlLabel.title = currentDraft.url;
    canRestoreOriginalTitle = await hasTitleOverride(currentDraft.titleOverrideKey);
    const headingText = canRestoreOriginalTitle ? '编辑收藏' : '收藏网页';
    form.dataset.saved = String(canRestoreOriginalTitle);
    document.title = headingText;
    if (headingLabel) headingLabel.textContent = headingText;
    restoreButton.hidden = !canRestoreOriginalTitle;
    setPending(false);
    titleInput.select();
  } catch (error) {
    renderError(error.message || '读取网页信息失败。');
  }
}

async function saveRename() {
  if (!currentDraft) {
    return;
  }

  const title = titleInput.value.trim().replace(/\s+/g, ' ');

  if (!title) {
    setError('标题不能为空。');
    titleInput.focus();
    return;
  }

  setPending(true);
  try {
    await saveTitleOverride(currentDraft.titleOverrideKey, title, {
      targetUrl: currentDraft.url
    });
    await deleteRenameDraft(currentDraft.id);
    showSuccessMessage(canRestoreOriginalTitle ? '已保存' : '已收藏');
    closeSoon();
  } catch (error) {
    setPending(false);
    setError(error.message || '保存失败。');
  }
}

async function restoreOriginalTitle() {
  if (!currentDraft) {
    return;
  }

  titleInput.value = currentDraft.originalTitle || currentDraft.url || '';

  setPending(true);
  try {
    await deleteTitleOverrides([currentDraft.titleOverrideKey]);
    await deleteRenameDraft(currentDraft.id);
    showSuccessMessage('已取消收藏');
    closeSoon();
  } catch (error) {
    setPending(false);
    setError(error.message || '取消收藏失败。');
  }
}

async function hasTitleOverride(titleOverrideKey) {
  const overrides = await loadTitleOverrides();
  return overrides.has(titleOverrideKey);
}

function renderError(message) {
  titleInput.disabled = true;
  restoreButton.disabled = true;
  setError(message);
}

function setError(message) {
  statusLabel.textContent = message;
}

function setPending(isPending) {
  titleInput.disabled = isPending;
  restoreButton.disabled = isPending || !canRestoreOriginalTitle;
  cancelButton.disabled = isPending;
  const submitButton = form.querySelector('button[type="submit"]');
  const normalizedValue = titleInput.value.trim().replace(/\s+/g, ' ');
  const normalizedInitial = String(currentDraft?.currentTitle ?? '').trim().replace(/\s+/g, ' ');
  // Unbookmarked pages can be saved directly without changing their title.
  const unchangedExisting = canRestoreOriginalTitle && normalizedValue === normalizedInitial;
  submitButton.disabled = isPending || !currentDraft || !normalizedValue || unchangedExisting;
  submitButton.textContent = isPending ? '处理中' : (canRestoreOriginalTitle ? '保存' : '收藏');

  if (isPending) {
    setError('');
  }
}

function showSuccessMessage(message) {
  document.querySelector('.rename-message')?.remove();

  const element = document.createElement('div');
  element.className = 'rename-message';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');

  const icon = document.createElement('span');
  icon.className = 'rename-message-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✓';

  const text = document.createElement('span');
  text.textContent = message;
  element.append(icon, text);
  document.body.append(element);
}

function closeWindow() {
  globalThis.close();
}

function closeSoon() {
  globalThis.setTimeout(closeWindow, 1200);
}

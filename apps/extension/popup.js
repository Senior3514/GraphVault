/**
 * GraphVault Web Clipper — popup script.
 *
 * Orchestrates the clip → edit → save flow:
 *   1. User clicks "Clip selection" or "Clip page".
 *   2. Popup sends a message to the active tab's content script.
 *   3. Content script returns { markdown, title, url }.
 *   4. Popup populates the form and shows the preview.
 *   5. User edits title / tag and clicks "Download .md" or "Send to GraphVault".
 *
 * All state is ephemeral (in this variable scope). Settings (vault URL) are
 * persisted via chrome.storage.sync.
 */

/* -------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------- */

/** @type {{ markdown: string, title: string, url: string } | null} */
let clipped = null;

/* -------------------------------------------------------------------------
 * DOM helpers
 * ---------------------------------------------------------------------- */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const btnClipSelection = /** @type {HTMLButtonElement} */ ($('btn-clip-selection'));
const btnClipPage      = /** @type {HTMLButtonElement} */ ($('btn-clip-page'));
const btnDownload      = /** @type {HTMLButtonElement} */ ($('btn-download'));
const btnSendVault     = /** @type {HTMLButtonElement} */ ($('btn-send-vault'));
const btnSettings      = /** @type {HTMLButtonElement} */ ($('btn-settings'));
const btnSaveSettings  = /** @type {HTMLButtonElement} */ ($('btn-save-settings'));
const btnCloseSettings = /** @type {HTMLButtonElement} */ ($('btn-close-settings'));
const fieldTitle       = /** @type {HTMLInputElement}  */ ($('field-title'));
const fieldTag         = /** @type {HTMLInputElement}  */ ($('field-tag'));
const fieldVaultUrl    = /** @type {HTMLInputElement}  */ ($('field-vault-url'));
const statusEl         = $('status');
const previewBlock     = /** @type {HTMLDetailsElement} */ ($('preview-block'));
const previewText      = $('preview-text');
const settingsPanel    = $('settings-panel');

/* -------------------------------------------------------------------------
 * Status helpers
 * ---------------------------------------------------------------------- */

/** @param {string} msg @param {'ok'|'err'|''} kind */
function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

/** Enable or disable the save buttons. */
function setSaveEnabled(enabled) {
  btnDownload.disabled = !enabled;
  btnSendVault.disabled = !enabled;
}

/* -------------------------------------------------------------------------
 * Clip flow
 * ---------------------------------------------------------------------- */

/**
 * Send a clip message to the active tab's content script and handle the result.
 * @param {'GV_CLIP_SELECTION'|'GV_CLIP_PAGE'} type
 */
async function clip(type) {
  setStatus('Clipping…', '');
  setSaveEnabled(false);
  btnClipSelection.disabled = true;
  btnClipPage.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    /** @type {{ ok: boolean, data?: { markdown: string, title: string, url: string }, error?: string }} */
    const response = await chrome.tabs.sendMessage(tab.id, { type });

    if (!response?.ok) {
      throw new Error(response?.error || 'Content script did not respond.');
    }

    clipped = response.data;
    applyClipResult(clipped);
    setStatus('Clipped. Edit then save.', 'ok');
  } catch (err) {
    setStatus(friendlyError(String(err)), 'err');
  } finally {
    btnClipSelection.disabled = false;
    btnClipPage.disabled = false;
  }
}

/**
 * Populate form fields and preview from a clip result.
 * @param {{ markdown: string, title: string, url: string }} result
 */
function applyClipResult(result) {
  if (!fieldTitle.value) {
    fieldTitle.value = result.title.trim();
  }
  previewText.textContent = result.markdown;
  previewBlock.hidden = false;
  setSaveEnabled(true);
}

/* -------------------------------------------------------------------------
 * Build the final Markdown note content
 * ---------------------------------------------------------------------- */

/**
 * Assemble the full note Markdown from current form state + clipped data.
 * @returns {string}
 */
function buildNoteMarkdown() {
  if (!clipped) return '';

  const title = fieldTitle.value.trim() || clipped.title || 'Clipping';
  const rawTag = fieldTag.value.trim();
  // Normalise tag: strip leading #, lowercase, replace spaces with hyphens
  const tag = rawTag
    ? '#' + rawTag.replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase()
    : null;

  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    `# ${title}`,
    '',
    `> Clipped from: ${clipped.url}`,
    `> Date: ${today}`,
    tag ? `> Tags: ${tag}` : null,
    '',
    '---',
    '',
    clipped.markdown,
  ].filter(l => l !== null);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------
 * Download action
 * ---------------------------------------------------------------------- */

async function downloadNote() {
  const content = buildNoteMarkdown();
  if (!content) { setStatus('Nothing to save — clip a page first.', 'err'); return; }

  const title = fieldTitle.value.trim() || clipped?.title || 'note';
  setStatus('Saving…', '');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GV_DOWNLOAD',
      filename: title,
      content,
    });
    if (response?.ok) {
      setStatus('Saved to Downloads folder.', 'ok');
    } else {
      throw new Error(response?.error || 'Download failed.');
    }
  } catch (err) {
    setStatus(friendlyError(String(err)), 'err');
  }
}

/* -------------------------------------------------------------------------
 * Send to GraphVault action
 * ---------------------------------------------------------------------- */

async function sendToVault() {
  const content = buildNoteMarkdown();
  if (!content) { setStatus('Nothing to send — clip a page first.', 'err'); return; }

  const vaultUrl = await getVaultUrl();
  const deepLink = `${vaultUrl.replace(/\/$/, '')}/vault?new=${encodeURIComponent(content)}`;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GV_OPEN_VAULT',
      vaultUrl: deepLink,
    });
    if (response?.ok) {
      setStatus('Opened in GraphVault.', 'ok');
      // Close the popup after a brief moment so the user sees the confirmation
      setTimeout(() => window.close(), 900);
    } else {
      throw new Error(response?.error || 'Could not open tab.');
    }
  } catch (err) {
    setStatus(friendlyError(String(err)), 'err');
  }
}

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

const DEFAULT_VAULT_URL = 'http://localhost:3000';

/** @returns {Promise<string>} */
async function getVaultUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['gvVaultUrl'], (result) => {
      resolve(result.gvVaultUrl || DEFAULT_VAULT_URL);
    });
  });
}

async function openSettings() {
  settingsPanel.hidden = false;
  fieldVaultUrl.value = await getVaultUrl();
  fieldVaultUrl.focus();
}

function closeSettings() {
  settingsPanel.hidden = true;
}

async function saveSettings() {
  const url = fieldVaultUrl.value.trim();
  if (url && !isValidUrl(url)) {
    setStatus('Invalid URL — must start with http:// or https://', 'err');
    return;
  }
  await new Promise((resolve) => {
    chrome.storage.sync.set({ gvVaultUrl: url || DEFAULT_VAULT_URL }, resolve);
  });
  closeSettings();
  setStatus('Settings saved.', 'ok');
}

/** @param {string} url */
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Error formatting
 * ---------------------------------------------------------------------- */

/** @param {string} err */
function friendlyError(err) {
  if (err.includes('Could not establish connection')) {
    return 'Cannot reach the page. Try reloading it and clipping again.';
  }
  if (err.includes('No active tab')) {
    return 'No active tab found.';
  }
  return err.replace(/^Error:\s*/i, '');
}

/* -------------------------------------------------------------------------
 * Wire up event listeners
 * ---------------------------------------------------------------------- */

btnClipSelection.addEventListener('click', () => clip('GV_CLIP_SELECTION'));
btnClipPage.addEventListener('click', () => clip('GV_CLIP_PAGE'));
btnDownload.addEventListener('click', downloadNote);
btnSendVault.addEventListener('click', sendToVault);
btnSettings.addEventListener('click', openSettings);
btnSaveSettings.addEventListener('click', saveSettings);
btnCloseSettings.addEventListener('click', closeSettings);

// Allow pressing Enter in settings URL field to save
fieldVaultUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings();
});

// Initial state: disable save buttons until a clip is made
setSaveEnabled(false);

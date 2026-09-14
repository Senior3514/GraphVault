/**
 * GraphVault Web Clipper - popup script.
 *
 * Orchestrates the clip → edit → save flow:
 *   1. User clicks "Clip selection" or "Clip page".
 *   2. Popup sends a message to the active tab's content script.
 *   3. Content script returns { markdown, title, url }.
 *   4. Popup populates the form and shows the preview.
 *   5. User edits title / tag and clicks "Download .md", "Send to GraphVault",
 *      or "Send to server inbox".
 *
 * All state is ephemeral (in this variable scope). The local-vault deep-link
 * URL (`gvVaultUrl`) and the self-hosted server URL (`gvServerUrl`) are
 * persisted via chrome.storage.sync (plain URL preferences - fine to roam with
 * the browser account). The inbox token (`gvInboxToken`) is a bearer secret
 * and is persisted via chrome.storage.local ONLY, so it never silently
 * replicates to every device signed into the user's browser account.
 */

/* -------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------- */

/** @type {{ markdown: string, title: string, url: string } | null} */
let clipped = null;

/** Whether a clip is currently loaded (gates the save buttons). */
let hasClip = false;

/** Whether both a server URL and an inbox token are configured. */
let serverConfigured = false;

/* -------------------------------------------------------------------------
 * DOM helpers
 * ---------------------------------------------------------------------- */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const btnClipSelection = /** @type {HTMLButtonElement} */ ($('btn-clip-selection'));
const btnClipPage      = /** @type {HTMLButtonElement} */ ($('btn-clip-page'));
const btnDownload      = /** @type {HTMLButtonElement} */ ($('btn-download'));
const btnSendVault     = /** @type {HTMLButtonElement} */ ($('btn-send-vault'));
const btnSendInbox     = /** @type {HTMLButtonElement} */ ($('btn-send-inbox'));
const btnSettings      = /** @type {HTMLButtonElement} */ ($('btn-settings'));
const btnSaveSettings  = /** @type {HTMLButtonElement} */ ($('btn-save-settings'));
const btnCloseSettings = /** @type {HTMLButtonElement} */ ($('btn-close-settings'));
const fieldTitle       = /** @type {HTMLInputElement}  */ ($('field-title'));
const fieldTag         = /** @type {HTMLInputElement}  */ ($('field-tag'));
const fieldVaultUrl    = /** @type {HTMLInputElement}  */ ($('field-vault-url'));
const fieldServerUrl   = /** @type {HTMLInputElement}  */ ($('field-server-url'));
const fieldInboxToken  = /** @type {HTMLInputElement}  */ ($('field-inbox-token'));
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

/** Enable or disable the save buttons based on current clip + config state. */
function updateButtonStates() {
  btnDownload.disabled = !hasClip;
  btnSendVault.disabled = !hasClip;
  btnSendInbox.disabled = !hasClip || !serverConfigured;
}

/**
 * @param {boolean} enabled  whether a clip is loaded
 */
function setSaveEnabled(enabled) {
  hasClip = enabled;
  updateButtonStates();
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
 * Normalise a raw tag: strip leading '#', lowercase, replace spaces with
 * hyphens. Returns null for an empty/whitespace-only input.
 *
 * Shared by buildNoteMarkdown() (embeds it as "#tag" in the note body) and
 * buildInboxRequestBody() (sends it bare in the `tags` array) so the two
 * save paths never drift apart.
 *
 * @param {string} rawTag
 * @returns {string | null}
 */
function normalizeTag(rawTag) {
  const t = (rawTag || '').trim();
  if (!t) return null;
  return t.replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase();
}

/**
 * Assemble the full note Markdown from current form state + clipped data.
 * @returns {string}
 */
function buildNoteMarkdown() {
  if (!clipped) return '';

  const title = fieldTitle.value.trim() || clipped.title || 'Clipping';
  const tag = normalizeTag(fieldTag.value);

  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    `# ${title}`,
    '',
    `> Clipped from: ${clipped.url}`,
    `> Date: ${today}`,
    tag ? `> Tags: #${tag}` : null,
    '',
    '---',
    '',
    clipped.markdown,
  ].filter(l => l !== null);

  return lines.join('\n');
}

/**
 * Build the JSON body for `POST /v1/inbox/:token`, matching the server's
 * zod schema exactly: { title?, markdown, tags?, source? }.
 *
 * Reuses the same full note Markdown (`markdown`) and the same tag
 * normalisation (`normalizeTag`) as the other two save paths - the inbox
 * note is byte-for-byte the same content the user previewed.
 *
 * @param {{ title: string, tag: string, markdown: string, source: string }} params
 * @returns {{ title: string, markdown: string, tags?: string[], source: string }}
 */
function buildInboxRequestBody({ title, tag, markdown, source }) {
  /** @type {{ title: string, markdown: string, tags?: string[], source: string }} */
  const body = { title, markdown, source };
  const normalized = normalizeTag(tag);
  if (normalized) body.tags = [normalized];
  return body;
}

/* -------------------------------------------------------------------------
 * Download action
 * ---------------------------------------------------------------------- */

async function downloadNote() {
  const content = buildNoteMarkdown();
  if (!content) { setStatus('Nothing to save - clip a page first.', 'err'); return; }

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
  if (!content) { setStatus('Nothing to send - clip a page first.', 'err'); return; }

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
 * Send to server inbox action
 * ---------------------------------------------------------------------- */

/** The optional host permission requested at runtime, never at install time. */
const INBOX_HOST_PERMISSIONS = { origins: ['http://*/*', 'https://*/*'] };

/**
 * @returns {Promise<boolean>} whether the extension already holds the
 * broad host permission needed to fetch an arbitrary self-hosted server.
 */
function hasHostPermission() {
  return new Promise((resolve) => {
    chrome.permissions.contains(INBOX_HOST_PERMISSIONS, (granted) => resolve(!!granted));
  });
}

/**
 * Request the optional host permission. MUST be called from within a user
 * gesture (e.g. a button click handler) - browsers refuse permission
 * prompts triggered outside one.
 * @returns {Promise<boolean>} whether the user granted it
 */
function requestHostPermission() {
  return new Promise((resolve) => {
    chrome.permissions.request(INBOX_HOST_PERMISSIONS, (granted) => resolve(!!granted));
  });
}

/**
 * Map a `POST /v1/inbox/:token` HTTP status to an honest, specific message.
 * Never a generic "something went wrong" - the server's contract is known.
 * @param {number} status
 * @returns {string}
 */
function mapInboxStatusError(status) {
  if (status === 201) return '';
  if (status === 404) return 'Server rejected the token - check it in Settings.';
  if (status === 413) return 'This clip is too large for the inbox endpoint.';
  if (status === 429) return 'Rate limited by the server - wait a moment and try again.';
  return `Server returned an unexpected error (HTTP ${status}).`;
}

async function sendToInbox() {
  if (!clipped) { setStatus('Nothing to send - clip a page first.', 'err'); return; }
  const content = buildNoteMarkdown();
  if (!content) { setStatus('Nothing to send - clip a page first.', 'err'); return; }

  const { serverUrl, token } = await getServerSettings();
  if (!serverUrl || !token) {
    setStatus('Set your server URL and inbox token in Settings first.', 'err');
    return;
  }

  const granted = await hasHostPermission();
  if (!granted) {
    setStatus('GraphVault needs permission to contact your server - requesting…', '');
    const nowGranted = await requestHostPermission();
    if (!nowGranted) {
      setStatus('Permission denied - cannot reach your server without it.', 'err');
      return;
    }
  }

  const title = fieldTitle.value.trim() || clipped.title || 'Clipping';
  const body = buildInboxRequestBody({
    title,
    tag: fieldTag.value,
    markdown: content,
    source: clipped.url,
  });

  setStatus('Sending to your server…', '');
  let response;
  try {
    response = await fetch(`${serverUrl.replace(/\/$/, '')}/v1/inbox/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    setStatus('Could not reach the server - check the server URL.', 'err');
    return;
  }

  if (response.ok) {
    setStatus('Sent to your GraphVault server inbox.', 'ok');
    setTimeout(() => window.close(), 900);
    return;
  }
  setStatus(mapInboxStatusError(response.status), 'err');
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

/**
 * Read the self-hosted server URL (chrome.storage.sync - a plain URL
 * preference) and the inbox token (chrome.storage.local - a bearer secret,
 * deliberately NOT synced across the browser account's devices).
 * @returns {Promise<{ serverUrl: string, token: string }>}
 */
async function getServerSettings() {
  const serverUrl = await new Promise((resolve) => {
    chrome.storage.sync.get(['gvServerUrl'], (result) => resolve((result.gvServerUrl || '').trim()));
  });
  const token = await new Promise((resolve) => {
    chrome.storage.local.get(['gvInboxToken'], (result) => resolve((result.gvInboxToken || '').trim()));
  });
  return { serverUrl, token };
}

/** Re-read server settings and refresh whether "Send to server inbox" can be enabled. */
async function refreshServerConfigured() {
  const { serverUrl, token } = await getServerSettings();
  serverConfigured = Boolean(serverUrl && token);
  updateButtonStates();
}

async function openSettings() {
  settingsPanel.hidden = false;
  const [vaultUrl, serverSettings] = await Promise.all([getVaultUrl(), getServerSettings()]);
  fieldVaultUrl.value = vaultUrl;
  fieldServerUrl.value = serverSettings.serverUrl;
  fieldInboxToken.value = serverSettings.token;
  fieldVaultUrl.focus();
}

function closeSettings() {
  settingsPanel.hidden = true;
}

async function saveSettings() {
  const url = fieldVaultUrl.value.trim();
  if (url && !isValidUrl(url)) {
    setStatus('Invalid GraphVault URL - must start with http:// or https://', 'err');
    return;
  }
  const serverUrl = fieldServerUrl.value.trim();
  if (serverUrl && !isValidUrl(serverUrl)) {
    setStatus('Invalid server URL - must start with http:// or https://', 'err');
    return;
  }
  const token = fieldInboxToken.value.trim();

  await new Promise((resolve) => {
    chrome.storage.sync.set({ gvVaultUrl: url || DEFAULT_VAULT_URL, gvServerUrl: serverUrl }, resolve);
  });
  await new Promise((resolve) => {
    chrome.storage.local.set({ gvInboxToken: token }, resolve);
  });

  await refreshServerConfigured();
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
btnSendInbox.addEventListener('click', sendToInbox);
btnSettings.addEventListener('click', openSettings);
btnSaveSettings.addEventListener('click', saveSettings);
btnCloseSettings.addEventListener('click', closeSettings);

// Allow pressing Enter in settings URL fields to save
fieldVaultUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings();
});
fieldServerUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings();
});
fieldInboxToken.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings();
});

// Initial state: disable save buttons until a clip is made, and read whether
// a server + token are already configured (so "Send to server inbox" can be
// enabled the moment a clip is made, without waiting for Settings to open).
setSaveEnabled(false);
refreshServerConfigured();

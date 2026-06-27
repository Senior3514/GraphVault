/**
 * GraphVault Web Clipper - MV3 service worker (background).
 *
 * Responsibilities:
 * - Relay DOWNLOAD messages from the popup to the chrome.downloads API.
 * - Relay OPEN_GRAPHVAULT messages to open the vault deep link in a new tab.
 *
 * The popup communicates with this service worker via chrome.runtime.sendMessage
 * because `chrome.downloads` is not available in popup scripts in all browsers.
 *
 * Message API:
 *   { type: 'GV_DOWNLOAD', filename: string, content: string }
 *     → downloads content as a UTF-8 .md file
 *
 *   { type: 'GV_OPEN_VAULT', vaultUrl: string }
 *     → opens the URL in a new tab
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GV_DOWNLOAD') {
    const { filename, content } = message;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download(
      { url, filename: sanitizeFilename(filename), saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
        URL.revokeObjectURL(url);
      }
    );
    return true; // async
  }

  if (message.type === 'GV_OPEN_VAULT') {
    const { vaultUrl } = message;
    chrome.tabs.create({ url: vaultUrl }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  return false;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a user-supplied note title into a safe filename.
 * Keeps alphanumerics, spaces, hyphens, underscores, and dots.
 * Truncates to 200 characters. Falls back to "note" if empty.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  const safe = (name || 'note')
    .replace(/[^\w\s\-_.]/g, '')   // strip unsafe chars
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^[-_.]+|[-_.]+$/g, '') // trim leading/trailing punctuation
    .slice(0, 200)
    .toLowerCase();
  return (safe || 'note') + '.md';
}

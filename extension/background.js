// The floating extension view owns the network stream; this worker only tracks
// the active page and forwards toolbar clicks to the injected launcher.
const isSupported = (value) => {
  try {
    const url = new URL(value);
    const repository = /^\/([^/]+)\/[^/]+\/?$/.exec(url.pathname);
    const reserved = new Set(["about", "collections", "customer-stories", "enterprise", "events", "features", "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "readme", "search", "security", "settings", "signup", "sponsors", "topics"]);
    return url.protocol === "https:" && url.hostname === "github.com" && ((repository && !reserved.has(repository[1].toLowerCase())) || /^\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/.test(url.pathname));
  } catch { return false; }
};

async function contextFor(windowId) {
  const tabs = await chrome.tabs.query({ active: true, ...(windowId ? { windowId } : { lastFocusedWindow: true }) });
  const tab = tabs[0];
  return { url: tab?.url && isSupported(tab.url) ? tab.url : null, tabId: tab?.id ?? null };
}

async function announce(windowId) {
  const context = await contextFor(windowId);
  await chrome.runtime.sendMessage({ type: "GITHUB_CONTEXT_CHANGED", ...context, windowId }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id && tab.url && isSupported(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_REPOLENS" }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url && change.status !== "complete") return;
  // Leave the panel available: navigating away displays its empty state.
  if (tab.active) await announce(tab.windowId);
});

chrome.tabs.onActivated.addListener(({ windowId }) => { void announce(windowId); });
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void announce(windowId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["GET_GITHUB_CONTEXT", "GET_ISSUE_CONTEXT"].includes(message?.type)) return;
  contextFor(message.windowId).then(sendResponse).catch(() => sendResponse({ url: null, tabId: null }));
  return true;
});

import { translateTextDetailed } from "../lib/translator.js";
import { initializeDatabase, readDeckItems, writeDeckItems, createDeckItem } from "../lib/database.js";

const LAST_SELECTION_KEY = "lastTabSelection";
const DEFAULT_INLINE_TARGET_LANG = "vi";
const HIGHLIGHT_CONTEXT_MENU_ID = "toggle-highlight-current-page";
const HIGHLIGHT_PAGE_OVERRIDES_KEY = "highlightPageOverrides";
const HIGHLIGHT_STORAGE_KEYS = ["highlightEnabled", "highlightBlockedUrls", HIGHLIGHT_PAGE_OVERRIDES_KEY];
const SUPPORTED_HIGHLIGHT_PAGE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

let databaseReady = null;

async function setLastSelection(tabId, text) {
  if (!Number.isInteger(tabId)) return;

  const normalizedText = String(text || "").trim();
  if (!normalizedText) return;

  await chrome.storage.session.set({
    [LAST_SELECTION_KEY]: {
      tabId,
      text: normalizedText,
      updatedAt: Date.now()
    }
  });
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeHighlightBlockedUrlRule(value) {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return "";

  try {
    const url = new URL(normalizedValue);
    url.hash = "";
    return url.toString();
  } catch {
    return normalizedValue
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

function normalizeHighlightPageUrl(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return "";

  try {
    const url = new URL(rawValue);
    if (!SUPPORTED_HIGHLIGHT_PAGE_PROTOCOLS.has(url.protocol)) {
      return "";
    }

    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeHighlightBlockedUrls(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules.map((rule) => normalizeHighlightBlockedUrlRule(rule)).filter(Boolean))];
}

function normalizeHighlightPageOverrides(overrides) {
  const nextOverrides = {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return nextOverrides;
  }

  for (const [pageUrl, enabled] of Object.entries(overrides)) {
    const normalizedPageUrl = normalizeHighlightPageUrl(pageUrl);
    if (!normalizedPageUrl || typeof enabled !== "boolean") continue;
    nextOverrides[normalizedPageUrl] = enabled;
  }

  return nextOverrides;
}

function isHighlightBlockedOnPage(pageUrl, rules) {
  if (!pageUrl || !Array.isArray(rules) || !rules.length) return false;

  const currentUrl = pageUrl.toLowerCase();
  const parsedUrl = new URL(pageUrl);
  const currentHost = String(parsedUrl.hostname || "").toLowerCase();
  const currentWithoutScheme = `${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase();

  return rules.some((rule) => {
    const normalizedRule = normalizeHighlightBlockedUrlRule(rule);
    if (!normalizedRule) return false;

    if (normalizedRule.includes("://")) {
      return currentUrl.startsWith(normalizedRule.toLowerCase());
    }

    if (normalizedRule.includes("/") || normalizedRule.includes("?")) {
      return currentWithoutScheme.startsWith(normalizedRule);
    }

    return currentHost === normalizedRule || currentHost.endsWith(`.${normalizedRule}`);
  });
}

function getPageHighlightOverride(pageUrl, overrides) {
  if (!pageUrl || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(overrides, pageUrl)) {
    return null;
  }

  return typeof overrides[pageUrl] === "boolean" ? overrides[pageUrl] : null;
}

async function getHighlightSettings() {
  const data = await chrome.storage.local.get(HIGHLIGHT_STORAGE_KEYS);

  return {
    highlightEnabled: data.highlightEnabled !== false,
    highlightBlockedUrls: normalizeHighlightBlockedUrls(data.highlightBlockedUrls),
    highlightPageOverrides: normalizeHighlightPageOverrides(data[HIGHLIGHT_PAGE_OVERRIDES_KEY])
  };
}

function resolvePageHighlightState(pageUrl, settings) {
  const blockedByRule = isHighlightBlockedOnPage(pageUrl, settings.highlightBlockedUrls);
  const pageOverride = getPageHighlightOverride(pageUrl, settings.highlightPageOverrides);
  const pageEnabled = pageOverride === null ? !blockedByRule : pageOverride;

  return {
    blockedByRule,
    pageOverride,
    pageEnabled,
    effectiveEnabled: settings.highlightEnabled && pageEnabled
  };
}

function createChromeApiPromise(callbackInvoker) {
  return new Promise((resolve, reject) => {
    callbackInvoker(() => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

async function ensureHighlightContextMenu() {
  try {
    await createChromeApiPromise((done) => chrome.contextMenus.remove(HIGHLIGHT_CONTEXT_MENU_ID, done));
  } catch {
    // Ignore missing-item removal failures.
  }

  await createChromeApiPromise((done) =>
    chrome.contextMenus.create(
      {
        id: HIGHLIGHT_CONTEXT_MENU_ID,
        title: "Highlight current page",
        contexts: ["action"],
        type: "checkbox",
        checked: true
      },
      done
    )
  );
}

async function updateHighlightContextMenu(info = {}, tab) {
  const pageUrl = normalizeHighlightPageUrl(info.pageUrl || tab?.url || tab?.pendingUrl || "");

  let title = "Highlight current page";
  let enabled = true;
  let checked = true;

  if (!pageUrl) {
    checked = false;
    enabled = false;
  } else {
    const settings = await getHighlightSettings();
    if (!settings.highlightEnabled) {
      checked = false;
      enabled = false;
    } else {
      const pageState = resolvePageHighlightState(pageUrl, settings);
      checked = pageState.effectiveEnabled;
    }
  }

  await createChromeApiPromise((done) =>
    chrome.contextMenus.update(
      HIGHLIGHT_CONTEXT_MENU_ID,
      {
        title,
        enabled,
        checked
      },
      done
    )
  );

  if (typeof chrome.contextMenus.refresh === "function") {
    chrome.contextMenus.refresh();
  }
}

async function refreshHighlightForTab(tabId) {
  if (!Number.isInteger(tabId)) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: "refresh-highlight" });
  } catch {
    // Ignore tabs where the content script is unavailable.
  }
}

async function updateHighlightContextMenuForActiveTab() {
  if (!chrome.tabs?.query) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [tab] = tabs;
    if (!tab?.url && !tab?.pendingUrl) return;

    await updateHighlightContextMenu({}, tab);
  } catch {
    // Ignore tab lookup failures and keep the last menu state.
  }
}

async function toggleHighlightForCurrentPage(info = {}, tab) {
  const pageUrl = normalizeHighlightPageUrl(info.pageUrl || tab?.url || tab?.pendingUrl || "");
  if (!pageUrl) return;

  const settings = await getHighlightSettings();
  if (!settings.highlightEnabled) return;

  const pageState = resolvePageHighlightState(pageUrl, settings);
  const nextPageEnabled = typeof info.checked === "boolean" ? info.checked : !pageState.pageEnabled;
  const nextOverrides = { ...settings.highlightPageOverrides };

  // Only persist overrides that differ from the base blocked-rule behavior.
  if (nextPageEnabled === !pageState.blockedByRule) {
    delete nextOverrides[pageUrl];
  } else {
    nextOverrides[pageUrl] = nextPageEnabled;
  }

  await chrome.storage.local.set({ [HIGHLIGHT_PAGE_OVERRIDES_KEY]: nextOverrides });
  await refreshHighlightForTab(tab?.id);
  await updateHighlightContextMenu({ pageUrl }, tab);
}

function ensureDatabaseInitialized() {
  if (!databaseReady) {
    databaseReady = initializeDatabase().catch((error) => {
      databaseReady = null;
      throw error;
    });
  }

  return databaseReady;
}

async function getGoogleApiKey() {
  const data = await chrome.storage.local.get(["googleApiKey"]);
  return String(data.googleApiKey || "").trim();
}

async function translateInlineSelection(text, source = "auto", target = DEFAULT_INLINE_TARGET_LANG) {
  const apiKey = await getGoogleApiKey();
  const translation = await translateTextDetailed({
    text: normalizeText(text),
    source,
    target,
    apiKey
  });

  return {
    translatedText: normalizeText(translation.translatedText),
    detectedSourceLanguage: String(translation.detectedSourceLanguage || "").trim().toLowerCase()
  };
}

async function saveInlineDeckItem({ sourceText, translatedText, sourceLang, targetLang }) {
  await ensureDatabaseInitialized();

  const normalizedSourceText = normalizeText(sourceText);
  const normalizedTranslatedText = normalizeText(translatedText);
  const normalizedSourceLang = String(sourceLang || "auto").trim().toLowerCase() || "auto";
  const normalizedTargetLang = String(targetLang || DEFAULT_INLINE_TARGET_LANG).trim().toLowerCase() || DEFAULT_INLINE_TARGET_LANG;

  if (!normalizedSourceText || !normalizedTranslatedText) {
    throw new Error("Source text and translated text are required.");
  }

  const existingItems = await readDeckItems();
  const nextItem = createDeckItem({
    sourceText: normalizedSourceText,
    translatedText: normalizedTranslatedText,
    sourceLang: normalizedSourceLang,
    targetLang: normalizedTargetLang
  });
  const nextDeck = [nextItem, ...existingItems];

  await writeDeckItems(nextDeck, { allowStorageFallback: true });
  await chrome.storage.local.set({ deckItems: nextDeck });

  return nextItem;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureHighlightContextMenu();
  await ensureDatabaseInitialized();
  const existing = await chrome.storage.local.get(["highlightEnabled"]);
  if (typeof existing.highlightEnabled !== "boolean") {
    await chrome.storage.local.set({ highlightEnabled: true });
  }
  await updateHighlightContextMenuForActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  ensureHighlightContextMenu().catch(() => {
    // Ignore context menu recreation failures on startup.
  });
  updateHighlightContextMenuForActiveTab().catch(() => {
    // Ignore menu sync failures on startup.
  });
});

if (chrome.contextMenus?.onShown?.addListener) {
  chrome.contextMenus.onShown.addListener((info, tab) => {
    updateHighlightContextMenu(info, tab).catch(() => {
      // Ignore transient context menu update failures.
    });
  });
}

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(() => {
    updateHighlightContextMenuForActiveTab().catch(() => {
      // Ignore active-tab menu sync failures.
    });
  });
}

if (chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;

    updateHighlightContextMenu({}, tab).catch(() => {
      // Ignore tab-update menu sync failures.
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.highlightEnabled && !changes.highlightBlockedUrls && !changes[HIGHLIGHT_PAGE_OVERRIDES_KEY]) {
    return;
  }

  updateHighlightContextMenuForActiveTab().catch(() => {
    // Ignore storage-driven menu sync failures.
  });
});

if (chrome.contextMenus?.onClicked?.addListener) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== HIGHLIGHT_CONTEXT_MENU_ID) return;

    toggleHighlightForCurrentPage(info, tab).catch(() => {
      // Ignore toggle failures to avoid breaking unrelated background work.
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-highlight-enabled") {
    chrome.storage.local.get(["highlightEnabled"]).then((data) => {
      sendResponse({ enabled: data.highlightEnabled !== false });
    });
    return true;
  }

  if (message?.type === "set-highlight-enabled") {
    chrome.storage.local.set({ highlightEnabled: !!message.enabled }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "get-deck-items") {
    chrome.storage.local.get(["deckItems"]).then((data) => {
      sendResponse({ items: data.deckItems || [] });
    });
    return true;
  }

  if (message?.type === "selection-updated") {
    setLastSelection(sender.tab?.id, message.selectedText)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "get-last-selected-text") {
    chrome.storage.session.get([LAST_SELECTION_KEY]).then((data) => {
      const cachedSelection = data[LAST_SELECTION_KEY];
      const selectedText =
        cachedSelection?.tabId === message.tabId ? String(cachedSelection.text || "") : "";
      sendResponse({ selectedText });
    });
    return true;
  }

  if (message?.type === "translate-inline-selection") {
    translateInlineSelection(message.text, message.source, message.target)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Translation failed." }));
    return true;
  }

  if (message?.type === "save-inline-deck-item") {
    saveInlineDeckItem({
      sourceText: message.sourceText,
      translatedText: message.translatedText,
      sourceLang: message.sourceLang,
      targetLang: message.targetLang
    })
      .then((item) => sendResponse({ ok: true, item }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Could not save deck item." }));
    return true;
  }

  return false;
});

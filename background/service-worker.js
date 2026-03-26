import { translateTextDetailed } from "../lib/translator.js";
import {
  initializeDatabase,
  upsertDeckItem,
  createDeckItem,
  getHighlightLexicon,
  getDeckRevision,
  syncDatabaseToFile
} from "../lib/database.js";

const LAST_SELECTION_KEY = "lastTabSelection";
const DEFAULT_INLINE_TARGET_LANG = "vi";
const HIGHLIGHT_CONTEXT_MENU_ID = "toggle-highlight-current-page";
const HIGHLIGHT_PAGE_OVERRIDES_KEY = "highlightPageOverrides";
const HIGHLIGHT_STORAGE_KEYS = ["highlightEnabled", "highlightBlockedUrls", HIGHLIGHT_PAGE_OVERRIDES_KEY];
const SUPPORTED_HIGHLIGHT_PAGE_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const AUTO_SYNC_ENABLED_KEY = "dbAutoSyncEnabled";
const AUTO_SYNC_INTERVAL_MINUTES_KEY = "dbAutoSyncIntervalMinutes";
const AUTO_SYNC_ALARM_NAME = "database-auto-sync";
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 60;
const SUPPORTED_AUTO_SYNC_INTERVALS = new Set([5, 15, 30, 60, 180, 360, 720, 1440]);

let databaseReady = null;
let highlightContextMenuReady = null;
let highlightLexiconCache = {
  revision: -1,
  entries: null
};

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

function normalizeAutoSyncIntervalMinutes(value) {
  const numericValue = Number(value);
  return SUPPORTED_AUTO_SYNC_INTERVALS.has(numericValue) ? numericValue : DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
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

async function getAutoSyncSettings() {
  const data = await chrome.storage.local.get([AUTO_SYNC_ENABLED_KEY, AUTO_SYNC_INTERVAL_MINUTES_KEY]);
  return {
    enabled: data[AUTO_SYNC_ENABLED_KEY] === true,
    intervalMinutes: normalizeAutoSyncIntervalMinutes(data[AUTO_SYNC_INTERVAL_MINUTES_KEY])
  };
}

async function updateAutoSyncAlarm() {
  if (!chrome.alarms?.clear || !chrome.alarms?.create) return;

  const settings = await getAutoSyncSettings();
  await chrome.alarms.clear(AUTO_SYNC_ALARM_NAME);
  if (!settings.enabled) {
    return;
  }

  chrome.alarms.create(AUTO_SYNC_ALARM_NAME, {
    delayInMinutes: settings.intervalMinutes,
    periodInMinutes: settings.intervalMinutes
  });
}

async function runAutomaticDatabaseSync() {
  const settings = await getAutoSyncSettings();
  if (!settings.enabled) return;

  await ensureDatabaseInitialized();

  try {
    await syncDatabaseToFile({ requestPermission: false });
  } catch {
    // Ignore automatic sync failures; manual sync in the popup can recover permission or file issues.
  }
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

function ensureHighlightContextMenu() {
  if (!highlightContextMenuReady) {
    highlightContextMenuReady = (async () => {
      try {
        await createChromeApiPromise((done) => chrome.contextMenus.remove(HIGHLIGHT_CONTEXT_MENU_ID, done));
      } catch {
        // Ignore missing-item removal failures.
      }

      try {
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
      } catch (error) {
        const message = error?.message || String(error || "");
        if (!message.includes("duplicate id")) {
          throw error;
        }

        await createChromeApiPromise((done) =>
          chrome.contextMenus.update(
            HIGHLIGHT_CONTEXT_MENU_ID,
            {
              title: "Highlight current page",
              enabled: true,
              checked: true
            },
            done
          )
        );
      }
    })().catch((error) => {
      highlightContextMenuReady = null;
      throw error;
    });
  }

  return highlightContextMenuReady;
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

async function refreshHighlightForTab(tabId, options = {}) {
  if (!Number.isInteger(tabId)) return;

  try {
    const message = { type: "refresh-highlight" };
    if (Number.isInteger(options.deckRevision)) {
      message.deckRevision = options.deckRevision;
    }

    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Ignore tabs where the content script is unavailable.
  }
}

async function refreshHighlightForTabIfEnabled(tabId, options = {}) {
  if (!Number.isInteger(tabId)) return;

  try {
    await ensureDatabaseInitialized();
    const settings = await getHighlightSettings();
    if (!settings.highlightEnabled) return;

    const tab = await chrome.tabs.get(tabId);
    const pageUrl = normalizeHighlightPageUrl(tab?.url || tab?.pendingUrl || "");
    if (!pageUrl) return;

    const pageState = resolvePageHighlightState(pageUrl, settings);
    if (!pageState.effectiveEnabled) return;

    const nextOptions = { ...options };
    if (!Number.isInteger(nextOptions.deckRevision)) {
      nextOptions.deckRevision = await getDeckRevision();
    }

    await refreshHighlightForTab(tabId, nextOptions);
  } catch {
    // Ignore tabs where refresh eligibility cannot be determined.
  }
}

async function refreshHighlightForAllTabs(options = {}) {
  if (!chrome.tabs?.query) return;

  try {
    const nextOptions = { ...options };
    if (!Number.isInteger(nextOptions.deckRevision)) {
      await ensureDatabaseInitialized();
      nextOptions.deckRevision = await getDeckRevision();
    }

    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .map((tab) => tab.id)
        .filter(Number.isInteger)
        .map((tabId) => refreshHighlightForTab(tabId, nextOptions))
    );
  } catch {
    // Ignore best-effort refresh failures across tabs.
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

  const nextItem = createDeckItem({
    sourceText: normalizedSourceText,
    translatedText: normalizedTranslatedText,
    sourceLang: normalizedSourceLang,
    targetLang: normalizedTargetLang
  });
  const result = await upsertDeckItem(nextItem);
  highlightLexiconCache = {
    revision: -1,
    entries: null
  };

  return result;
}

async function loadHighlightLexicon(sinceRevision = null) {
  await ensureDatabaseInitialized();

  const currentRevision = await getDeckRevision();
  if (Number.isInteger(sinceRevision) && sinceRevision === currentRevision) {
    return {
      revision: currentRevision,
      entries: null
    };
  }

  if (highlightLexiconCache.revision === currentRevision && Array.isArray(highlightLexiconCache.entries)) {
    return {
      revision: currentRevision,
      entries: highlightLexiconCache.entries
    };
  }

  const result = await getHighlightLexicon();
  highlightLexiconCache = {
    revision: result.revision,
    entries: Array.isArray(result.entries) ? result.entries : []
  };

  return {
    revision: result.revision,
    entries: highlightLexiconCache.entries
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureHighlightContextMenu();
  await ensureDatabaseInitialized();
  await updateAutoSyncAlarm();
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
  updateAutoSyncAlarm().catch(() => {
    // Ignore automatic sync alarm setup failures on startup.
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
  chrome.tabs.onActivated.addListener((activeInfo) => {
    refreshHighlightForTabIfEnabled(activeInfo.tabId).catch(() => {
      // Ignore active-tab refresh failures.
    });
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
  const highlightSettingsChanged =
    Boolean(changes.highlightEnabled) ||
    Boolean(changes.highlightBlockedUrls) ||
    Boolean(changes[HIGHLIGHT_PAGE_OVERRIDES_KEY]);
  const autoSyncSettingsChanged = Boolean(changes[AUTO_SYNC_ENABLED_KEY]) || Boolean(changes[AUTO_SYNC_INTERVAL_MINUTES_KEY]);

  if (highlightSettingsChanged) {
    refreshHighlightForAllTabs().catch(() => {
      // Ignore storage-driven highlight refresh failures.
    });
    updateHighlightContextMenuForActiveTab().catch(() => {
      // Ignore storage-driven menu sync failures.
    });
  }

  if (autoSyncSettingsChanged) {
    updateAutoSyncAlarm().catch(() => {
      // Ignore automatic sync alarm updates driven by storage changes.
    });
  }
});

if (chrome.contextMenus?.onClicked?.addListener) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== HIGHLIGHT_CONTEXT_MENU_ID) return;

    toggleHighlightForCurrentPage(info, tab).catch(() => {
      // Ignore toggle failures to avoid breaking unrelated background work.
    });
  });
}

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== AUTO_SYNC_ALARM_NAME) return;

    runAutomaticDatabaseSync().catch(() => {
      // Ignore automatic sync failures; they can be retried on the next interval.
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

  if (message?.type === "get-highlight-lexicon") {
    loadHighlightLexicon(Number.isInteger(message.sinceRevision) ? message.sinceRevision : null)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Could not load highlight data." }));
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
      .then(async ({ item, revision }) => {
        await refreshHighlightForTabIfEnabled(sender.tab?.id, { deckRevision: revision });
        sendResponse({ ok: true, item, revision });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Could not save deck item." }));
    return true;
  }

  return false;
});

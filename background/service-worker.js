import { translateTextDetailed } from "../lib/translator.js";
import { initializeDatabase, readDeckItems, writeDeckItems, createDeckItem } from "../lib/database.js";

const LAST_SELECTION_KEY = "lastTabSelection";
const DEFAULT_INLINE_TARGET_LANG = "vi";

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
  await ensureDatabaseInitialized();
  const existing = await chrome.storage.local.get(["highlightEnabled"]);
  if (typeof existing.highlightEnabled !== "boolean") {
    await chrome.storage.local.set({ highlightEnabled: true });
  }
});

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

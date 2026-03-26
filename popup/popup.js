import { LANGUAGES } from "../lib/languages.js";
import { lookupSourceAntonyms, lookupSourceSynonyms, translateTextDetailed, translateTextList } from "../lib/translator.js";
import {
  initializeDatabase,
  queryDeckItems,
  getDeckItem,
  listAllDeckItems,
  upsertDeckItem,
  replaceDeckItems,
  deleteDeckItems,
  chooseDatabaseSyncFile,
  getDatabaseLocationInfo,
  createDeckItem
} from "../lib/database.js";
import {
  DATABASE_LAST_SYNC_AT_KEY,
  getDatabaseSyncStatus,
  runDatabaseSyncNow,
  clearDatabaseLastSyncTime
} from "../lib/database-sync.js";

const state = {
  translated: "",
  sourceLang: "en",
  targetLang: "vi",
  synonyms: [],
  synonymsLoaded: false,
  antonyms: [],
  antonymsLoaded: false,
  thesaurusVisibleType: "",
  thesaurusStatusMessages: {
    synonyms: "",
    antonyms: ""
  },
  thesaurusTargetLang: "vi",
  thesaurusPage: 1,
  thesaurusPageSize: 5,
  deck: [],
  deckTotalCount: 0,
  selectedDeckIds: new Set(),
  editingDeckItemId: "",
  editingTranslationDraft: false,
  deckSort: "newest",
  deckPage: 1,
  deckPageSize: 10,
  deckLoadRequestId: 0,
  flashcardOrderMode: "time-desc",
  flashcardDeck: [],
  flashcardLoaded: false,
  flashcardSequenceIds: [],
  flashcardIndex: 0,
  flashcardShowingMeaning: false,
  googleApiKey: "",
  merriamWebsterApiKey: "",
  highlightBlockedUrls: []
};

const DECK_TRANSFER_FORMATS = {
  json: {
    extension: ".json",
    label: "JSON",
    mimeType: "application/json"
  },
  csv: {
    extension: ".csv",
    label: "CSV",
    mimeType: "text/csv"
  },
  txt: {
    extension: ".txt",
    label: "Plain text",
    mimeType: "text/plain"
  }
};

const DEFAULT_TRANSLATED_PLACEHOLDER = "Translation appears here...";
const DEFAULT_THESAURUS_MESSAGE = "Translate text first, then click Synonyms or Antonyms.";
const READY_THESAURUS_MESSAGE = "Click Synonyms or Antonyms to load suggestions.";
const THESAURUS_TYPES = ["synonyms", "antonyms"];
const FLASHCARD_ORDER_MODES = new Set(["random", "alpha-asc", "alpha-desc", "time-desc", "time-asc"]);
const THESAURUS_LABELS = {
  synonyms: "Synonyms",
  antonyms: "Antonyms"
};
const THESAURUS_SINGULAR_LABELS = {
  synonyms: "Synonym",
  antonyms: "Antonym"
};

const el = {
  app: document.querySelector(".app"),
  tabButtons: document.querySelectorAll(".tab-btn"),
  tabPanels: document.querySelectorAll(".tab-panel"),
  sourceLang: document.getElementById("sourceLang"),
  targetLang: document.getElementById("targetLang"),
  swapLangBtn: document.getElementById("swapLangBtn"),
  sourceText: document.getElementById("sourceText"),
  clearSourceTextBtn: document.getElementById("clearSourceTextBtn"),
  translatedText: document.getElementById("translatedText"),
  loadSynonymsBtn: document.getElementById("loadSynonymsBtn"),
  loadAntonymsBtn: document.getElementById("loadAntonymsBtn"),
  synonymResults: document.getElementById("synonymResults"),
  synonymPagination: document.getElementById("synonymPagination"),
  synonymPrevPageBtn: document.getElementById("synonymPrevPageBtn"),
  synonymNextPageBtn: document.getElementById("synonymNextPageBtn"),
  synonymPaginationLabel: document.getElementById("synonymPaginationLabel"),
  translateBtn: document.getElementById("translateBtn"),
  saveBtn: document.getElementById("saveBtn"),
  modifyBtn: document.getElementById("modifyBtn"),
  flashcardOrderMode: document.getElementById("flashcardOrderMode"),
  flashcardProgress: document.getElementById("flashcardProgress"),
  flashcardPrevBtn: document.getElementById("flashcardPrevBtn"),
  flashcardNextBtn: document.getElementById("flashcardNextBtn"),
  flashcardCard: document.getElementById("flashcardCard"),
  flashcardFaceLabel: document.getElementById("flashcardFaceLabel"),
  flashcardLanguageLabel: document.getElementById("flashcardLanguageLabel"),
  flashcardCardText: document.getElementById("flashcardCardText"),
  flashcardHint: document.getElementById("flashcardHint"),
  deckSearch: document.getElementById("deckSearch"),
  deckAddManualBtn: document.getElementById("deckAddManualBtn"),
  deckDeleteToolbarBtn: document.getElementById("deckDeleteToolbarBtn"),
  deckModifyToolbarBtn: document.getElementById("deckModifyToolbarBtn"),
  deckSort: document.getElementById("deckSort"),
  importDeckBtn: document.getElementById("importDeckBtn"),
  exportDeckBtn: document.getElementById("exportDeckBtn"),
  deckImportInput: document.getElementById("deckImportInput"),
  deckList: document.getElementById("deckList"),
  clearDeckSearchBtn: document.getElementById("clearDeckSearchBtn"),
  deckPrevPageBtn: document.getElementById("deckPrevPageBtn"),
  deckNextPageBtn: document.getElementById("deckNextPageBtn"),
  deckPaginationLabel: document.getElementById("deckPaginationLabel"),
  refreshDeckBtn: document.getElementById("refreshDeckBtn"),
  googleApiKey: document.getElementById("googleApiKey"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  clearApiKeyBtn: document.getElementById("clearApiKeyBtn"),
  merriamWebsterApiKey: document.getElementById("merriamWebsterApiKey"),
  saveMerriamWebsterBtn: document.getElementById("saveMerriamWebsterBtn"),
  clearMerriamWebsterBtn: document.getElementById("clearMerriamWebsterBtn"),
  dbSummaryLabel: document.getElementById("dbSummaryLabel"),
  dbLocationLabel: document.getElementById("dbLocationLabel"),
  dbLastSyncLabel: document.getElementById("dbLastSyncLabel"),
  importDbBtn: document.getElementById("importDbBtn"),
  chooseDbSyncBtn: document.getElementById("chooseDbSyncBtn"),
  syncDbBtn: document.getElementById("syncDbBtn"),
  highlightEnabled: document.getElementById("highlightEnabled"),
  highlightBlockUrlInput: document.getElementById("highlightBlockUrlInput"),
  addHighlightBlockUrlBtn: document.getElementById("addHighlightBlockUrlBtn"),
  highlightBlockUrlList: document.getElementById("highlightBlockUrlList"),
  settingsToast: document.getElementById("settingsToast"),
  saveToast: document.getElementById("saveToast"),
  status: document.getElementById("status")
};

let popupContextAvailable = true;
let popupResizeFrame = 0;
let saveToastTimeoutId = 0;
let settingsToastTimeoutId = 0;

function isExtensionContextInvalidatedError(error) {
  const message = error?.message || String(error || "");
  return message.includes("Extension context invalidated") || message.includes("context invalidated");
}

function isUserAbortError(error) {
  return error?.name === "AbortError" || String(error?.message || "").includes("The user aborted a request");
}

function hasLivePopupContext() {
  return popupContextAvailable && !!globalThis.chrome?.runtime?.id;
}

function invalidatePopupContext() {
  popupContextAvailable = false;
}

function getActivePopupTabName() {
  return document.querySelector(".tab-btn.active")?.dataset.tab || "";
}

function isFormField(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    Boolean(element?.isContentEditable)
  );
}

function hideSettingsToast() {
  if (!el.settingsToast) return;

  window.clearTimeout(settingsToastTimeoutId);
  el.settingsToast.classList.remove("visible");
  el.settingsToast.classList.remove("error");
  el.settingsToast.hidden = true;
}

function showSettingsToast(message, isError = false) {
  if (!el.settingsToast) return;

  window.clearTimeout(settingsToastTimeoutId);
  el.settingsToast.textContent = message;
  el.settingsToast.hidden = false;
  el.settingsToast.classList.toggle("error", isError);

  window.requestAnimationFrame(() => {
    el.settingsToast.classList.add("visible");
  });

  settingsToastTimeoutId = window.setTimeout(() => {
    el.settingsToast.classList.remove("visible");
    window.setTimeout(() => {
      if (!el.settingsToast.classList.contains("visible")) {
        el.settingsToast.classList.remove("error");
        el.settingsToast.hidden = true;
      }
    }, 180);
  }, 2200);
}

async function withPopupContext(task, fallbackValue = null) {
  if (!hasLivePopupContext()) {
    invalidatePopupContext();
    return fallbackValue;
  }

  try {
    return await task();
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      invalidatePopupContext();
      return fallbackValue;
    }

    throw error;
  }
}

function setStatus(message, isError = false) {
  if (!popupContextAvailable) return;

  if (getActivePopupTabName() === "settings") {
    showSettingsToast(message, isError);
  }

  if (!el.status) return;
  el.status.textContent = message;
  el.status.style.color = isError ? "#b42318" : "#245f5a";
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatDatabaseLastSyncTime(value) {
  if (!value) {
    return "Not synced yet.";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not synced yet.";
  }

  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())} ${padDatePart(date.getDate())}/${padDatePart(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function handlePopupAsyncError(error, fallbackMessage = "Operation failed.") {
  if (isExtensionContextInvalidatedError(error) || !hasLivePopupContext()) {
    invalidatePopupContext();
    return;
  }

  if (isUserAbortError(error)) {
    return;
  }

  setStatus(error?.message || fallbackMessage, true);
}

function showSaveToast(message) {
  if (!el.saveToast) return;

  window.clearTimeout(saveToastTimeoutId);
  el.saveToast.textContent = message;
  el.saveToast.hidden = false;

  window.requestAnimationFrame(() => {
    el.saveToast.classList.add("visible");
  });

  saveToastTimeoutId = window.setTimeout(() => {
    el.saveToast.classList.remove("visible");
    window.setTimeout(() => {
      if (!el.saveToast.classList.contains("visible")) {
        el.saveToast.hidden = true;
      }
    }, 180);
  }, 1800);
}

function bindAsyncEvent(target, eventName, handler, fallbackMessage = "Operation failed.") {
  target.addEventListener(eventName, (event) => {
    Promise.resolve(handler(event)).catch((error) => {
      handlePopupAsyncError(error, fallbackMessage);
    });
  });
}

function schedulePopupResize() {
  if (popupResizeFrame) return;

  popupResizeFrame = window.requestAnimationFrame(() => {
    popupResizeFrame = 0;

    if (!el.app) return;

    document.documentElement.style.height = "auto";
    document.documentElement.style.maxHeight = "none";
    document.body.style.height = "auto";
    document.body.style.maxHeight = "none";

    const popupHeight = Math.min(el.app.scrollHeight + 12, 600);

    document.documentElement.style.height = `${popupHeight}px`;
    document.documentElement.style.maxHeight = `${popupHeight}px`;
    document.body.style.height = `${popupHeight}px`;
    document.body.style.maxHeight = `${popupHeight}px`;
  });
}

function getThesaurusButton(type) {
  return type === "antonyms" ? el.loadAntonymsBtn : el.loadSynonymsBtn;
}

function getThesaurusItems(type) {
  return type === "antonyms" ? state.antonyms : state.synonyms;
}

function setThesaurusItems(type, items) {
  if (type === "antonyms") {
    state.antonyms = items;
    return;
  }

  state.synonyms = items;
}

function getThesaurusLoaded(type) {
  return type === "antonyms" ? state.antonymsLoaded : state.synonymsLoaded;
}

function setThesaurusLoaded(type, loaded) {
  if (type === "antonyms") {
    state.antonymsLoaded = loaded;
    return;
  }

  state.synonymsLoaded = loaded;
}

function getThesaurusLabel(type) {
  return THESAURUS_LABELS[type] || THESAURUS_LABELS.synonyms;
}

function getThesaurusSingularLabel(type) {
  return THESAURUS_SINGULAR_LABELS[type] || THESAURUS_SINGULAR_LABELS.synonyms;
}

function setThesaurusStatusMessage(type, message) {
  state.thesaurusStatusMessages[type] = message;
}

function getThesaurusStatusMessage(type) {
  return state.thesaurusStatusMessages[type] || DEFAULT_THESAURUS_MESSAGE;
}

function setThesaurusButtonState({ disabled = true, loadingType = "" } = {}) {
  THESAURUS_TYPES.forEach((type) => {
    const button = getThesaurusButton(type);
    if (!button) return;

    button.disabled = disabled;

    if (loadingType === type) {
      button.textContent = "Loading...";
      return;
    }

    if (state.thesaurusVisibleType === type) {
      button.textContent = `Hide ${getThesaurusLabel(type)}`;
      return;
    }

    button.textContent = getThesaurusLoaded(type) ? `Show ${getThesaurusLabel(type)}` : getThesaurusLabel(type);
  });
}

function updateSynonymPagination(totalItems) {
  const pageSize = state.thesaurusPageSize;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 1;
  state.thesaurusPage = Math.min(Math.max(state.thesaurusPage, 1), totalPages);

  if (!totalItems) {
    el.synonymPagination.hidden = true;
    el.synonymPaginationLabel.textContent = "0 - 0 of 0";
    el.synonymPrevPageBtn.disabled = true;
    el.synonymNextPageBtn.disabled = true;
    return { startIndex: 0, endIndex: 0 };
  }

  const startIndex = (state.thesaurusPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  el.synonymPagination.hidden = totalItems <= pageSize;
  el.synonymPaginationLabel.textContent = `${startIndex + 1} - ${endIndex} of ${totalItems}`;
  el.synonymPrevPageBtn.disabled = state.thesaurusPage <= 1;
  el.synonymNextPageBtn.disabled = state.thesaurusPage >= totalPages;

  return { startIndex, endIndex };
}

function showSynonymPanel(type) {
  state.thesaurusVisibleType = type;
  el.synonymResults.hidden = false;
  el.app?.classList.add("synonym-open");
}

function hideSynonymPanel() {
  state.thesaurusVisibleType = "";
  el.synonymResults.hidden = true;
  el.synonymPagination.hidden = true;
  el.app?.classList.remove("synonym-open");
  setThesaurusButtonState({ disabled: !state.translated.trim() });
  schedulePopupResize();
}

function renderSynonymMessage(type, message = DEFAULT_THESAURUS_MESSAGE) {
  setThesaurusStatusMessage(type, message);
  const emptyState = document.createElement("div");
  emptyState.className = "synonym-empty";
  emptyState.textContent = message;
  el.synonymResults.replaceChildren(emptyState);
  updateSynonymPagination(0);
  schedulePopupResize();
}

function findLanguageName(code) {
  return LANGUAGES.find((lang) => lang.code === code)?.name || String(code || "").toUpperCase();
}

function renderSynonymResults(type, items, targetLang) {
  if (!items.length) {
    renderSynonymMessage(type, `No ${getThesaurusSingularLabel(type).toLowerCase()} suggestions found for this text.`);
    return;
  }

  const { startIndex, endIndex } = updateSynonymPagination(items.length);
  const pageItems = items.slice(startIndex, endIndex);

  const header = document.createElement("div");
  header.className = "synonym-results-head";

  const sourceLabel = document.createElement("div");
  sourceLabel.textContent = getThesaurusSingularLabel(type);

  const targetLabel = document.createElement("div");
  targetLabel.textContent = `Meaning (${findLanguageName(targetLang)})`;

  header.append(sourceLabel, targetLabel);

  const body = document.createElement("div");
  body.className = "synonym-results-body";

  pageItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "synonym-results-row";

    const synonymCell = document.createElement("div");
    synonymCell.className = "synonym-source";
    synonymCell.textContent = item.sourceText;

    const meaningCell = document.createElement("div");
    meaningCell.className = "synonym-meaning";
    meaningCell.textContent = item.translatedText;

    row.append(synonymCell, meaningCell);
    body.appendChild(row);
  });

  el.synonymResults.replaceChildren(header, body);
  schedulePopupResize();
}

function resetSynonymOutput(message = DEFAULT_THESAURUS_MESSAGE) {
  state.synonyms = [];
  state.synonymsLoaded = false;
  state.antonyms = [];
  state.antonymsLoaded = false;
  state.thesaurusStatusMessages = {
    synonyms: message,
    antonyms: message
  };
  state.thesaurusPage = 1;
  hideSynonymPanel();
}

function goToSynonymPage(nextPage) {
  if (!state.thesaurusVisibleType) return;
  state.thesaurusPage = Math.max(1, nextPage);
  renderSynonymResults(state.thesaurusVisibleType, getThesaurusItems(state.thesaurusVisibleType), state.thesaurusTargetLang);
}

function showCachedSynonymPanel(type) {
  state.thesaurusPage = 1;
  showSynonymPanel(type);
  const items = getThesaurusItems(type);
  if (items.length) {
    renderSynonymResults(type, items, state.thesaurusTargetLang);
  } else {
    renderSynonymMessage(type, getThesaurusStatusMessage(type));
  }
  setThesaurusButtonState({ disabled: !state.translated.trim() });
}

function isEditingDeckItem() {
  return Boolean(state.editingDeckItemId);
}

function isEditingTranslationDraft() {
  return Boolean(state.editingTranslationDraft);
}

function isTranslationEditable() {
  return isEditingDeckItem() || isEditingTranslationDraft();
}

function setTranslatedTextEditable(editable) {
  el.translatedText.readOnly = !editable;
  el.translatedText.classList.toggle("editable-translation", editable);
}

function syncTranslatedTextEditableState() {
  setTranslatedTextEditable(isTranslationEditable());
}

function getCurrentTranslatedText() {
  return (isTranslationEditable() ? el.translatedText.value : state.translated).trim();
}

function updateTranslateSaveButtonState() {
  const hasSource = Boolean(el.sourceText.value.trim());
  const translatedText = getCurrentTranslatedText();

  if (isTranslationEditable()) {
    state.translated = translatedText;
  }

  el.saveBtn.disabled = isTranslationEditable() ? !(hasSource && translatedText) : !translatedText;
  updateModifyButtonState();
}

function updateSaveButtonLabel() {
  if (isEditingDeckItem()) {
    el.saveBtn.textContent = "Update Card";
    el.saveBtn.title = "Update selected card";
    return;
  }

  el.saveBtn.textContent = "Save";
  el.saveBtn.title = isEditingTranslationDraft() ? "Save the modified card to the deck" : "Save to Deck";
}

function updateModifyButtonState() {
  if (!el.modifyBtn) return;

  const draftEditing = isEditingTranslationDraft();
  const hasTranslation = Boolean((state.translated || el.translatedText.value).trim());
  const editingDeckItem = isEditingDeckItem();

  el.modifyBtn.disabled = editingDeckItem || (!draftEditing && !hasTranslation);
  el.modifyBtn.classList.toggle("is-active", draftEditing);
  el.modifyBtn.setAttribute("aria-pressed", draftEditing ? "true" : "false");
  el.modifyBtn.title = editingDeckItem
    ? "Already modifying the selected card"
    : draftEditing
      ? "Editing source and translation before saving"
      : "Modify source and translation before saving";
}

function exitTranslationDraftEditMode() {
  if (!isEditingTranslationDraft()) return;

  state.editingTranslationDraft = false;
  syncTranslatedTextEditableState();
  updateSaveButtonLabel();
  updateTranslateSaveButtonState();
}

function enterTranslationDraftEditMode() {
  if (isEditingDeckItem()) {
    return;
  }

  if (isEditingTranslationDraft()) {
    exitTranslationDraftEditMode();
    setStatus("Modify mode turned off.");
    return;
  }

  const sourceText = el.sourceText.value.trim();
  const translatedText = getCurrentTranslatedText();

  if (!sourceText || !translatedText) {
    setStatus("Translate text before modifying.", true);
    return;
  }

  state.editingTranslationDraft = true;
  el.translatedText.value = translatedText;
  state.translated = translatedText;
  syncTranslatedTextEditableState();
  updateSaveButtonLabel();
  updateTranslateSaveButtonState();
  resetSynonymOutput("Synonyms and antonyms update after the next translation.");
  schedulePopupResize();
  el.translatedText.focus();
  const caretPosition = el.translatedText.value.length;
  el.translatedText.setSelectionRange(caretPosition, caretPosition);
  setStatus("You can edit both fields before saving.");
}

function exitDeckEditMode() {
  if (!isEditingDeckItem()) return;

  state.editingDeckItemId = "";
  syncTranslatedTextEditableState();
  updateSaveButtonLabel();
  updateTranslateSaveButtonState();
}

function resetTranslationOutput(placeholder = DEFAULT_TRANSLATED_PLACEHOLDER) {
  exitTranslationDraftEditMode();
  state.translated = "";
  el.translatedText.value = "";
  el.translatedText.placeholder = placeholder;
  updateTranslateSaveButtonState();
}

function resetTranslateOutputs({
  translatedPlaceholder = DEFAULT_TRANSLATED_PLACEHOLDER,
  synonymMessage = DEFAULT_THESAURUS_MESSAGE
} = {}) {
  resetTranslationOutput(translatedPlaceholder);
  resetSynonymOutput(synonymMessage);
  setThesaurusButtonState({ disabled: true });
}

function normalizeDeckTextValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
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

function normalizeImportedLanguageCode(value, fallback) {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  return normalized || fallback;
}

function normalizeImportedCreatedAt(value) {
  if (value == null || value === "") return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function createImportedDeckItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const sourceText = normalizeDeckTextValue(
    rawItem.sourceText ?? rawItem.source ?? rawItem.term ?? rawItem.front ?? rawItem.originalText
  );
  const translatedText = normalizeDeckTextValue(
    rawItem.translatedText ?? rawItem.translation ?? rawItem.meaning ?? rawItem.back ?? rawItem.definition
  );

  if (!sourceText || !translatedText) return null;

  const sourceLang = normalizeImportedLanguageCode(
    rawItem.sourceLang ?? rawItem.sourceLanguage ?? rawItem.from,
    "auto"
  );
  const targetLang = normalizeImportedLanguageCode(
    rawItem.targetLang ?? rawItem.targetLanguage ?? rawItem.to,
    "vi"
  );
  const createdAt = normalizeImportedCreatedAt(
    rawItem.createdAt ?? rawItem.savedAt ?? rawItem.timestamp ?? rawItem.date
  );
  const importedId = typeof rawItem.id === "string" ? rawItem.id.trim() : "";

  const item = createDeckItem({
    sourceText,
    translatedText,
    sourceLang,
    targetLang
  });

  if (createdAt) {
    item.createdAt = createdAt;
  }

  if (importedId) {
    item.id = importedId;
  }

  return item;
}

function buildDeckItemSignature(item) {
  return [
    normalizeDeckTextValue(item?.sourceText).toLowerCase(),
    normalizeDeckTextValue(item?.translatedText).toLowerCase(),
    normalizeImportedLanguageCode(item?.sourceLang, "auto"),
    normalizeImportedLanguageCode(item?.targetLang, "vi")
  ].join("\u0001");
}

function detectDeckTransferFormat(filename = "") {
  const normalizedName = String(filename).trim().toLowerCase();
  if (normalizedName.endsWith(".db")) return "json";
  if (normalizedName.endsWith(".json")) return "json";
  if (normalizedName.endsWith(".csv")) return "csv";
  if (normalizedName.endsWith(".txt") || normalizedName.endsWith(".text")) return "txt";
  return "";
}

function detectDeckTransferFormatFromContent(text = "") {
  const normalizedText = String(text).trim();
  if (!normalizedText) return "";

  if (normalizedText.startsWith("{") || normalizedText.startsWith("[")) {
    return "json";
  }

  const lines = normalizedText.split(/\r?\n/).filter(Boolean).slice(0, 4);
  if (lines.some((line) => line.includes(",") && !line.includes("\t"))) {
    return "csv";
  }

  return "txt";
}

function escapeCsvCell(value) {
  const normalizedValue = String(value ?? "");
  if (!/[",\r\n]/.test(normalizedValue)) return normalizedValue;
  return `"${normalizedValue.replaceAll('"', '""')}"`;
}

function parseCsvRows(text) {
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          currentValue += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentValue += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  if (currentValue || currentRow.length) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => String(cell).trim()));
}

function normalizeImportHeader(value) {
  return normalizeDeckTextValue(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function mapCsvHeaders(headers) {
  const aliases = {
    id: "id",
    sourcetext: "sourceText",
    source: "sourceText",
    term: "sourceText",
    front: "sourceText",
    originaltext: "sourceText",
    translatedtext: "translatedText",
    translation: "translatedText",
    meaning: "translatedText",
    back: "translatedText",
    definition: "translatedText",
    sourcelang: "sourceLang",
    sourcelanguage: "sourceLang",
    from: "sourceLang",
    targetlang: "targetLang",
    targetlanguage: "targetLang",
    to: "targetLang",
    createdat: "createdAt",
    savedat: "createdAt",
    timestamp: "createdAt",
    date: "createdAt"
  };

  return headers.map((header) => aliases[normalizeImportHeader(header)] || "");
}

function parseCsvDeck(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];

  const mappedHeaders = mapCsvHeaders(rows[0]);
  const hasHeader = mappedHeaders.some(Boolean);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .map((row) => {
      if (hasHeader) {
        const rawItem = {};
        mappedHeaders.forEach((header, index) => {
          if (!header) return;
          rawItem[header] = row[index] ?? "";
        });
        return createImportedDeckItem(rawItem);
      }

      return createImportedDeckItem({
        sourceText: row[0],
        translatedText: row[1],
        sourceLang: row[2],
        targetLang: row[3],
        createdAt: row[4],
        id: row[5]
      });
    })
    .filter(Boolean);
}

function escapePlainTextField(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function unescapePlainTextField(value) {
  return String(value ?? "")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\");
}

function splitPlainTextLine(line) {
  if (line.includes("\t")) {
    return line.split("\t");
  }

  const separators = [" => ", " -> ", " | "];
  for (const separator of separators) {
    const separatorIndex = line.indexOf(separator);
    if (separatorIndex >= 0) {
      return [line.slice(0, separatorIndex), line.slice(separatorIndex + separator.length)];
    }
  }

  return [];
}

function looksLikePlainTextHeader(parts) {
  if (!parts.length) return false;
  const normalizedParts = parts.map((part) => normalizeImportHeader(part));
  return normalizedParts.includes("sourcetext") && normalizedParts.includes("translatedtext");
}

function parsePlainTextDeck(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  return lines
    .map((line) => splitPlainTextLine(line))
    .filter((parts) => parts.length >= 2 && !looksLikePlainTextHeader(parts))
    .map((parts) =>
      createImportedDeckItem({
        sourceText: unescapePlainTextField(parts[0]),
        translatedText: unescapePlainTextField(parts[1]),
        sourceLang: unescapePlainTextField(parts[2] ?? ""),
        targetLang: unescapePlainTextField(parts[3] ?? ""),
        createdAt: unescapePlainTextField(parts[4] ?? ""),
        id: unescapePlainTextField(parts[5] ?? "")
      })
    )
    .filter(Boolean);
}

function parseJsonDeck(text) {
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.deckItems)
      ? parsed.deckItems
      : Array.isArray(parsed?.deck)
        ? parsed.deck
        : Array.isArray(parsed?.items)
          ? parsed.items
          : null;

  if (!items) {
    throw new Error("JSON import must contain an array of deck items.");
  }

  return items.map((item) => createImportedDeckItem(item)).filter(Boolean);
}

function parseDeckImportText(text, format) {
  if (format === "json") {
    return parseJsonDeck(text);
  }

  if (format === "csv") {
    return parseCsvDeck(text);
  }

  if (format === "txt") {
    return parsePlainTextDeck(text);
  }

  throw new Error("Unsupported import format.");
}

function autoParseDeckImportText(text, filename = "") {
  const detectedByName = detectDeckTransferFormat(filename);
  const detectedByContent = detectDeckTransferFormatFromContent(text);
  const candidateFormats = [...new Set([detectedByName, detectedByContent, "json", "csv", "txt"].filter(Boolean))];
  let lastError = null;

  for (const format of candidateFormats) {
    try {
      const items = parseDeckImportText(text, format);
      if (items.length) {
        return { items, format };
      }

      lastError = new Error("No valid cards found in the selected file.");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not detect the import file format.");
}

function mergeImportedDeckItems(existingItems, importedItems) {
  const knownSignatures = new Set(existingItems.map((item) => buildDeckItemSignature(item)));
  const mergedDeck = [...existingItems];
  let importedCount = 0;
  let skippedCount = 0;

  for (const item of importedItems) {
    const signature = buildDeckItemSignature(item);
    if (knownSignatures.has(signature)) {
      skippedCount += 1;
      continue;
    }

    knownSignatures.add(signature);
    mergedDeck.push(item);
    importedCount += 1;
  }

  return { mergedDeck, importedCount, skippedCount };
}

function serializeDeckAsJson(items) {
  return JSON.stringify(
    {
      format: "vocab-translator-deck",
      exportedAt: new Date().toISOString(),
      deckItems: items
    },
    null,
    2
  );
}

function serializeDeckAsCsv(items) {
  const headers = ["sourceText", "translatedText", "sourceLang", "targetLang", "createdAt", "id"];
  const rows = items.map((item) =>
    headers.map((header) => escapeCsvCell(item?.[header] ?? "")).join(",")
  );

  return [headers.join(","), ...rows].join("\r\n");
}

function serializeDeckAsPlainText(items) {
  const lines = items.map((item) =>
    [
      escapePlainTextField(item.sourceText),
      escapePlainTextField(item.translatedText),
      escapePlainTextField(item.sourceLang),
      escapePlainTextField(item.targetLang),
      escapePlainTextField(item.createdAt),
      escapePlainTextField(item.id)
    ].join("\t")
  );

  return ["sourceText\ttranslatedText\tsourceLang\ttargetLang\tcreatedAt\tid", ...lines].join("\r\n");
}

function buildDeckExportContent(items, format) {
  if (format === "json") {
    return serializeDeckAsJson(items);
  }

  if (format === "csv") {
    return serializeDeckAsCsv(items);
  }

  if (format === "txt") {
    return serializeDeckAsPlainText(items);
  }

  throw new Error("Unsupported export format.");
}

function buildDeckExportFileName(format) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `vocab-deck-${timestamp}${DECK_TRANSFER_FORMATS[format].extension}`;
}

async function chooseDeckImportFile() {
  if (window.showOpenFilePicker) {
    const [fileHandle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "Deck Import Files",
          accept: {
            "application/octet-stream": [".db"],
            "application/json": [".json"],
            "text/csv": [".csv"],
            "text/plain": [".txt", ".text"]
          }
        }
      ]
    });

    return await fileHandle.getFile();
  }

  return await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      el.deckImportInput.removeEventListener("change", handleChange);
      el.deckImportInput.removeEventListener("cancel", handleCancel);
      window.removeEventListener("focus", handleWindowFocus, true);
    };

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleChange = () => {
      const [file] = el.deckImportInput.files || [];
      el.deckImportInput.value = "";
      if (file) {
        settle(() => resolve(file));
      } else {
        settle(() => reject(new DOMException("The user aborted a request.", "AbortError")));
      }
    };

    const handleCancel = () => {
      el.deckImportInput.value = "";
      settle(() => reject(new DOMException("The user aborted a request.", "AbortError")));
    };

    const handleWindowFocus = () => {
      window.setTimeout(() => {
        if (settled) return;
        const [file] = el.deckImportInput.files || [];
        if (file) return;

        el.deckImportInput.value = "";
        settle(() => reject(new DOMException("The user aborted a request.", "AbortError")));
      }, 0);
    };

    el.deckImportInput.addEventListener("change", handleChange);
    el.deckImportInput.addEventListener("cancel", handleCancel);
    window.addEventListener("focus", handleWindowFocus, true);
    el.deckImportInput.value = "";
    el.deckImportInput.click();
  });
}

async function saveDeckExportFile(items) {
  const defaultFormat = "json";
  const defaultFormatConfig = DECK_TRANSFER_FORMATS[defaultFormat];
  const defaultFileName = buildDeckExportFileName(defaultFormat);
  let selectedFormat = defaultFormat;

  if (window.showSaveFilePicker) {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName: defaultFileName,
      types: [
        {
          description: `${DECK_TRANSFER_FORMATS.json.label} file`,
          accept: { [DECK_TRANSFER_FORMATS.json.mimeType]: [DECK_TRANSFER_FORMATS.json.extension] }
        },
        {
          description: `${DECK_TRANSFER_FORMATS.csv.label} file`,
          accept: { [DECK_TRANSFER_FORMATS.csv.mimeType]: [DECK_TRANSFER_FORMATS.csv.extension] }
        },
        {
          description: `${DECK_TRANSFER_FORMATS.txt.label} file`,
          accept: { [DECK_TRANSFER_FORMATS.txt.mimeType]: [DECK_TRANSFER_FORMATS.txt.extension] }
        }
      ]
    });

    selectedFormat = detectDeckTransferFormat(fileHandle.name) || defaultFormat;
    const content = buildDeckExportContent(items, selectedFormat);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return selectedFormat;
  }

  const content = buildDeckExportContent(items, defaultFormat);
  const blob = new Blob([content], { type: `${defaultFormatConfig.mimeType};charset=utf-8` });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = defaultFileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return defaultFormat;
}

function switchTab(tabName, options = {}) {
  const { focusDeckSearch = false, focusTranslateInput = false } = options;

  el.tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle("active", active);
  });

  el.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });

  if (tabName !== "settings") {
    hideSettingsToast();
  }

  schedulePopupResize();

  if (tabName === "deck" && focusDeckSearch) {
    focusDeckSearchInput();
  }

  if (tabName === "translate" && focusTranslateInput) {
    focusSourceText(true);
  }
}

function focusSourceText(moveCaretToEnd = false) {
  window.setTimeout(() => {
    if (!(el.sourceText instanceof HTMLTextAreaElement)) return;

    el.sourceText.focus();

    if (moveCaretToEnd) {
      const caretPosition = el.sourceText.value.length;
      el.sourceText.setSelectionRange(caretPosition, caretPosition);
    }
  }, 0);
}

function focusDeckSearchInput(moveCaretToEnd = true) {
  window.setTimeout(() => {
    if (!(el.deckSearch instanceof HTMLInputElement)) return;

    el.deckSearch.focus();

    if (moveCaretToEnd) {
      const caretPosition = el.deckSearch.value.length;
      el.deckSearch.setSelectionRange(caretPosition, caretPosition);
    }
  }, 0);
}

function updateSwapLanguageButtonState() {
  if (!el.swapLangBtn) return;

  const disabled = el.sourceLang.value === "auto";
  el.swapLangBtn.disabled = disabled;
  el.swapLangBtn.title = disabled ? 'Choose a specific "From" language to enable switching.' : "Swap languages";
}

function updateClearSourceTextButtonState() {
  if (!el.clearSourceTextBtn) return;

  el.clearSourceTextBtn.hidden = !el.sourceText.value.trim();
}

function updateClearDeckSearchButtonState() {
  if (!el.clearDeckSearchBtn) return;

  el.clearDeckSearchBtn.hidden = !el.deckSearch.value;
}

function clearSourceText() {
  if (!el.sourceText.value && !el.translatedText.value && !isEditingDeckItem()) return;

  exitDeckEditMode();
  el.sourceText.value = "";
  resetTranslateOutputs();
  updateClearSourceTextButtonState();
  focusSourceText();
}

async function clearDeckSearch() {
  if (!el.deckSearch.value) return;

  el.deckSearch.value = "";
  state.deckPage = 1;
  updateClearDeckSearchButtonState();
  await refreshDeck();
  focusDeckSearchInput(false);
}

function handleTranslatedTextChanged() {
  if (!isTranslationEditable()) return;

  state.translated = el.translatedText.value.trim();
  updateTranslateSaveButtonState();
  schedulePopupResize();
}

function enterDeckEditMode(item) {
  state.editingTranslationDraft = false;
  state.editingDeckItemId = item.id;
  state.sourceLang = item.sourceLang || "auto";
  state.targetLang = item.targetLang || "vi";

  el.sourceLang.value = state.sourceLang;
  el.targetLang.value = state.targetLang;
  el.sourceText.value = item.sourceText;
  el.translatedText.value = item.translatedText;
  el.translatedText.placeholder = DEFAULT_TRANSLATED_PLACEHOLDER;
  state.translated = item.translatedText.trim();

  syncTranslatedTextEditableState();
  updateSaveButtonLabel();
  updateSwapLanguageButtonState();
  updateClearSourceTextButtonState();
  updateTranslateSaveButtonState();
  resetSynonymOutput(READY_THESAURUS_MESSAGE);
  setThesaurusButtonState({ disabled: !state.translated.trim() });
  switchTab("translate");
  schedulePopupResize();
  focusSourceText(true);
}

function swapSelectedLanguages() {
  const currentSourceLang = el.sourceLang.value;
  const currentTargetLang = el.targetLang.value;

  if (currentSourceLang === "auto") {
    setStatus('Choose a specific "From" language before switching.', true);
    updateSwapLanguageButtonState();
    return;
  }

  el.sourceLang.value = currentTargetLang;
  el.targetLang.value = currentSourceLang;
  updateSwapLanguageButtonState();
  state.sourceLang = el.sourceLang.value;
  state.targetLang = el.targetLang.value;

  const currentSourceText = el.sourceText.value;
  const currentTranslatedText = el.translatedText.value;

  if (currentTranslatedText.trim()) {
    el.sourceText.value = currentTranslatedText;
    el.translatedText.value = currentSourceText;
    state.translated = currentSourceText.trim();
    resetSynonymOutput("Synonyms and antonyms update after the next translation.");
    setThesaurusButtonState({ disabled: true });
    updateTranslateSaveButtonState();
  } else {
    resetTranslateOutputs();
  }

  updateClearSourceTextButtonState();
  setStatus("Languages switched.");
}

function readSelectionFromPage() {
  const activeElement = document.activeElement;

  if (activeElement instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = activeElement;
    if (selectionStart !== selectionEnd) {
      return value.slice(selectionStart, selectionEnd).trim();
    }
  }

  if (activeElement instanceof HTMLInputElement) {
    const supportedTypes = new Set(["text", "search", "url", "tel", "password"]);
    if (supportedTypes.has(activeElement.type)) {
      const { selectionStart, selectionEnd, value } = activeElement;
      if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
        return value.slice(selectionStart, selectionEnd).trim();
      }
    }
  }

  return window.getSelection?.()?.toString?.().trim?.() || "";
}

async function getActiveTab() {
  const tabs = await withPopupContext(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }), []);
  const [tab] = tabs;
  return tab || null;
}

async function refreshHighlightInActiveTab(options = {}) {
  const { showSuccessStatus = false, showFailureStatus = false, deckRevision = null } = options;
  const highlightSetting = await withPopupContext(() => chrome.storage.local.get(["highlightEnabled"]), null);
  if (!highlightSetting || highlightSetting.highlightEnabled === false) {
    return false;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    if (showFailureStatus) {
      setStatus("No active tab found.", true);
    }
    return false;
  }

  try {
    const message = { type: "refresh-highlight" };
    if (Number.isInteger(deckRevision)) {
      message.deckRevision = deckRevision;
    }

    const response = await withPopupContext(() => chrome.tabs.sendMessage(tab.id, message), null);
    if (!popupContextAvailable) return false;
    if (!response?.ok) {
      throw new Error("Open a normal webpage tab first, then try again.");
    }

    if (showSuccessStatus) {
      setStatus("Applied highlight refresh to current tab.");
    }
    return true;
  } catch {
    if (showFailureStatus) {
      setStatus("Open a normal webpage tab first, then try again.", true);
    }
    return false;
  }
}

async function getSelectedTextFromActiveTab(tabId) {
  try {
    const contentSelection = await withPopupContext(
      () => chrome.tabs.sendMessage(tabId, { type: "get-selected-text" }),
      null
    );
    const contentSelectedText = contentSelection?.selectedText?.trim?.() || "";
    if (contentSelectedText) return contentSelectedText;
  } catch {
    // Fall through to other retrieval strategies.
  }

  try {
    const cachedSelection = await withPopupContext(
      () => chrome.runtime.sendMessage({ type: "get-last-selected-text", tabId }),
      null
    );
    const cachedSelectedText = cachedSelection?.selectedText?.trim?.() || "";
    if (cachedSelectedText) return cachedSelectedText;
  } catch {
    // Fall through to direct page inspection.
  }

  try {
    const results = await withPopupContext(
      () =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: readSelectionFromPage
        }),
      null
    );
    return results?.[0]?.result?.trim?.() || "";
  } catch {
    return "";
  }
}

async function fillTranslateFromActiveTabSelection() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;

  const selectedText = await getSelectedTextFromActiveTab(tab.id);
  if (!selectedText) return false;

  el.sourceText.value = selectedText;
  resetTranslateOutputs();
  updateClearSourceTextButtonState();
  setStatus("Selected text loaded into Translate.");
  return true;
}

function handleTranslateInputsChanged() {
  state.sourceLang = el.sourceLang.value;
  state.targetLang = el.targetLang.value;
  if (isTranslationEditable()) {
    resetSynonymOutput("Synonyms and antonyms update after the next translation.");
    updateClearSourceTextButtonState();
    updateTranslateSaveButtonState();
    return;
  }

  resetTranslateOutputs();
  updateClearSourceTextButtonState();
}

function handleSourceTextKeyDown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();
  Promise.resolve(translateCurrentText()).catch((error) => {
    handlePopupAsyncError(error, "Translation failed.");
  });
}

function renderLanguages() {
  for (const lang of LANGUAGES) {
    const optionFrom = document.createElement("option");
    optionFrom.value = lang.code;
    optionFrom.textContent = lang.name;

    const optionTo = document.createElement("option");
    optionTo.value = lang.code;
    optionTo.textContent = lang.name;

    el.sourceLang.appendChild(optionFrom);
    el.targetLang.appendChild(optionTo);
  }

  el.sourceLang.value = state.sourceLang;
  el.targetLang.value = state.targetLang;
  updateSwapLanguageButtonState();
}

function formatDeckTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
}

function formatDeckLanguageIndicator(sourceLang, targetLang) {
  const source = String(sourceLang || "").toUpperCase();
  const target = String(targetLang || "").toUpperCase();
  return `${source} -> ${target}`;
}

function formatItemCountLabel(count) {
  return `${count} item${count === 1 ? "" : "s"}`;
}

function getDeckItemTimestamp(item) {
  const timestamp = Date.parse(item?.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortDeckItemsByNewest(items) {
  return [...items].sort((left, right) => {
    const timestampDiff = getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    if (timestampDiff !== 0) return timestampDiff;
    return String(right?.id || "").localeCompare(String(left?.id || ""));
  });
}

function normalizeFlashcardOrderMode(value) {
  return FLASHCARD_ORDER_MODES.has(value) ? value : "time-desc";
}

function shuffleDeckItems(items) {
  const shuffledItems = [...items];

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledItems[index], shuffledItems[swapIndex]] = [shuffledItems[swapIndex], shuffledItems[index]];
  }

  return shuffledItems;
}

function sortFlashcardItems(items, orderMode = state.flashcardOrderMode) {
  if (orderMode === "random") {
    return shuffleDeckItems(items);
  }

  const sortedItems = [...items];
  sortedItems.sort((left, right) => {
    if (orderMode === "alpha-asc") {
      const sourceDiff = String(left?.sourceText || "").localeCompare(String(right?.sourceText || ""));
      if (sourceDiff !== 0) return sourceDiff;
      return getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    }

    if (orderMode === "alpha-desc") {
      const sourceDiff = String(right?.sourceText || "").localeCompare(String(left?.sourceText || ""));
      if (sourceDiff !== 0) return sourceDiff;
      return getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    }

    if (orderMode === "time-asc") {
      const timestampDiff = getDeckItemTimestamp(left) - getDeckItemTimestamp(right);
      if (timestampDiff !== 0) return timestampDiff;
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    }

    const timestampDiff = getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    if (timestampDiff !== 0) return timestampDiff;
    return String(right?.id || "").localeCompare(String(left?.id || ""));
  });

  return sortedItems;
}

function buildFlashcardSequence(items = state.flashcardDeck) {
  const sequenceItems = sortFlashcardItems(items, state.flashcardOrderMode);
  return sequenceItems.map((item) => item.id);
}

function getCurrentFlashcardItem() {
  const currentId = state.flashcardSequenceIds[state.flashcardIndex];
  if (!currentId) return null;

  return state.flashcardDeck.find((item) => item.id === currentId) || null;
}

function ensureFlashcardSequence() {
  if (!state.flashcardDeck.length) {
    state.flashcardSequenceIds = [];
    state.flashcardIndex = 0;
    state.flashcardShowingMeaning = false;
    return;
  }

  if (!state.flashcardSequenceIds.length) {
    state.flashcardSequenceIds = buildFlashcardSequence(state.flashcardDeck);
    state.flashcardIndex = 0;
  }

  if (state.flashcardIndex >= state.flashcardSequenceIds.length) {
    state.flashcardIndex = 0;
  }

  if (!getCurrentFlashcardItem()) {
    state.flashcardSequenceIds = buildFlashcardSequence(state.flashcardDeck);
    state.flashcardIndex = 0;
  }
}

function renderFlashcard() {
  ensureFlashcardSequence();

  const currentItem = getCurrentFlashcardItem();
  const totalCards = state.flashcardSequenceIds.length;
  const showingMeaning = state.flashcardShowingMeaning;

  el.flashcardOrderMode.value = state.flashcardOrderMode;

  if (!currentItem || !totalCards) {
    el.flashcardProgress.textContent = "0 of 0";
    el.flashcardPrevBtn.disabled = true;
    el.flashcardNextBtn.disabled = true;
    el.flashcardCard.disabled = true;
    el.flashcardCard.dataset.face = "empty";
    el.flashcardCard.setAttribute("aria-label", "No flashcards available");
    el.flashcardFaceLabel.textContent = "Flashcards";
    el.flashcardLanguageLabel.textContent = "Deck";
    el.flashcardCardText.textContent = "Add cards to your deck to start reviewing.";
    el.flashcardHint.textContent = "Click a card to flip between the original text and its meaning.";
    el.flashcardHint.hidden = false;
    schedulePopupResize();
    return;
  }

  el.flashcardProgress.textContent = `${state.flashcardIndex + 1} of ${totalCards}`;
  el.flashcardPrevBtn.disabled = false;
  el.flashcardNextBtn.disabled = false;
  el.flashcardCard.disabled = false;
  el.flashcardCard.dataset.face = showingMeaning ? "back" : "front";
  el.flashcardFaceLabel.textContent = showingMeaning ? "Meaning" : "Original";
  el.flashcardLanguageLabel.textContent = formatDeckLanguageIndicator(currentItem.sourceLang, currentItem.targetLang);
  el.flashcardCardText.textContent = showingMeaning ? currentItem.translatedText : currentItem.sourceText;
  el.flashcardHint.textContent = "";
  el.flashcardHint.hidden = true;
  el.flashcardCard.setAttribute(
    "aria-label",
    showingMeaning
      ? `Flashcard meaning: ${currentItem.translatedText}`
      : `Flashcard original text: ${currentItem.sourceText}`
  );
  schedulePopupResize();
}

function resetFlashcardSession() {
  state.flashcardSequenceIds = buildFlashcardSequence(state.flashcardDeck);
  state.flashcardIndex = 0;
  state.flashcardShowingMeaning = false;
  renderFlashcard();
}

function toggleFlashcardFace() {
  if (!getCurrentFlashcardItem()) return;

  state.flashcardShowingMeaning = !state.flashcardShowingMeaning;
  renderFlashcard();
}

function goToFlashcardStep(step) {
  if (!state.flashcardDeck.length) {
    renderFlashcard();
    return;
  }

  ensureFlashcardSequence();

  if (!state.flashcardSequenceIds.length) {
    renderFlashcard();
    return;
  }

  const totalCards = state.flashcardSequenceIds.length;
  state.flashcardIndex = (state.flashcardIndex + step + totalCards) % totalCards;
  state.flashcardShowingMeaning = false;
  renderFlashcard();
}

async function loadFlashcardDeck(force = false) {
  if (state.flashcardLoaded && !force) {
    return;
  }

  state.flashcardDeck = sortDeckItemsByNewest(await listAllDeckItems());
  state.flashcardLoaded = true;
  resetFlashcardSession();
}

function invalidateFlashcardDeck() {
  state.flashcardLoaded = false;
  state.flashcardDeck = [];
  state.flashcardSequenceIds = [];
  state.flashcardIndex = 0;
  state.flashcardShowingMeaning = false;
  renderFlashcard();
}

function goToPreviousFlashcard() {
  goToFlashcardStep(-1);
}

function goToNextFlashcard() {
  goToFlashcardStep(1);
}

function updateDeckPagination(totalItems) {
  const pageSize = state.deckPageSize;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 1;
  state.deckPage = Math.min(Math.max(state.deckPage, 1), totalPages);

  if (!totalItems) {
    el.deckPaginationLabel.textContent = "0 - 0 of 0";
  } else {
    const startIndex = (state.deckPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalItems);
    el.deckPaginationLabel.textContent = `${startIndex + 1} - ${endIndex} of ${totalItems}`;
  }

  el.deckPrevPageBtn.disabled = totalItems === 0 || state.deckPage <= 1;
  el.deckNextPageBtn.disabled = totalItems === 0 || state.deckPage >= totalPages;

  return totalPages;
}

function renderDeck(items = state.deck) {
  const query = el.deckSearch.value.trim();
  updateDeckPagination(state.deckTotalCount);

  if (!items.length) {
    el.deckList.innerHTML = `<div class="deck-item">${query ? "No matching cards." : "No saved words yet."}</div>`;
    updateDeckToolbarState();
    schedulePopupResize();
    return;
  }

  const html = items
    .map(
      (item) => {
        const escapedId = escapeHtml(item.id);
        return `
      <div class="deck-item${state.selectedDeckIds.has(item.id) ? " selected" : ""}" data-id="${escapedId}">
        <div class="deck-item-row">
          <label class="deck-item-check-wrap" aria-label="Select ${escapeHtml(item.sourceText)}">
            <input
              class="deck-item-check"
              type="checkbox"
              data-id="${escapedId}"
              ${state.selectedDeckIds.has(item.id) ? "checked" : ""}
            />
          </label>
          <div class="deck-item-source">${escapeHtml(item.sourceText)}</div>
          <span class="deck-item-indicator">${escapeHtml(
            formatDeckLanguageIndicator(item.sourceLang, item.targetLang)
          )}</span>
          <div class="deck-item-translation">${escapeHtml(item.translatedText)}</div>
        </div>
        <div class="deck-item-time">${escapeHtml(formatDeckTime(item.createdAt))}</div>
      </div>
    `;
      }
    )
    .join("");

  el.deckList.innerHTML = html;
  updateDeckToolbarState();
  schedulePopupResize();
}

function renderHighlightBlockedUrlList() {
  if (!state.highlightBlockedUrls.length) {
    el.highlightBlockUrlList.innerHTML = '<div class="highlight-block-empty">No blocked URLs yet.</div>';
    schedulePopupResize();
    return;
  }

  el.highlightBlockUrlList.innerHTML = state.highlightBlockedUrls
    .map(
      (rule) => `
        <div class="highlight-block-item">
          <div class="highlight-block-rule">${escapeHtml(rule)}</div>
          <button
            type="button"
            class="highlight-block-remove"
            data-rule="${escapeHtml(rule)}"
            aria-label="Remove ${escapeHtml(rule)}"
          >
            Remove
          </button>
        </div>
      `
    )
    .join("");

  schedulePopupResize();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function refreshDeck() {
  const requestId = ++state.deckLoadRequestId;
  const result = await queryDeckItems({
    page: state.deckPage,
    pageSize: state.deckPageSize,
    sort: state.deckSort,
    query: el.deckSearch.value
  });

  if (requestId !== state.deckLoadRequestId) {
    return;
  }

  const totalPages = result.total > 0 ? Math.ceil(result.total / state.deckPageSize) : 1;
  if (result.total > 0 && state.deckPage > totalPages) {
    state.deckPage = totalPages;
    await refreshDeck();
    return;
  }

  state.deck = result.items;
  state.deckTotalCount = result.total;
  pruneDeckSelection();
  renderDeck();
}

async function syncDeckViewsAfterMutation(options = {}) {
  const { deckRevision = null, resetDeckPage = false } = options;

  if (resetDeckPage) {
    state.deckPage = 1;
  }

  await refreshDeck();

  if (getActivePopupTabName() === "flashcards") {
    await loadFlashcardDeck(true);
  } else {
    invalidateFlashcardDeck();
  }

  await refreshHighlightInActiveTab({ deckRevision });
}

async function refreshDatabaseLocationLabel() {
  const [info, syncStatus] = await Promise.all([getDatabaseLocationInfo(), getDatabaseSyncStatus()]);
  el.dbSummaryLabel.textContent = info.notice ? `${info.summary} ${info.notice}` : info.summary;
  el.dbLocationLabel.textContent = info.detail;
  if (el.dbLastSyncLabel) {
    el.dbLastSyncLabel.textContent = info.hasSyncFile
      ? formatDatabaseLastSyncTime(syncStatus?.lastSyncAt)
      : "Choose a sync file first.";
  }
}

async function loadFlashcardSettings() {
  const data = await withPopupContext(() => chrome.storage.local.get(["flashcardOrderMode"]), null);
  if (!data) {
    renderFlashcard();
    return;
  }

  state.flashcardOrderMode = normalizeFlashcardOrderMode(data.flashcardOrderMode);
  renderFlashcard();
}

async function saveFlashcardOrderMode() {
  await withPopupContext(() => chrome.storage.local.set({ flashcardOrderMode: state.flashcardOrderMode }), null);
}

async function changeFlashcardOrderMode() {
  state.flashcardOrderMode = normalizeFlashcardOrderMode(el.flashcardOrderMode.value);
  resetFlashcardSession();
  await saveFlashcardOrderMode();
  if (!popupContextAvailable) return;
  const modeLabel =
    state.flashcardOrderMode === "random"
      ? "random"
      : state.flashcardOrderMode === "alpha-asc"
        ? "alphabetical A-Z"
        : state.flashcardOrderMode === "alpha-desc"
          ? "alphabetical Z-A"
          : state.flashcardOrderMode === "time-asc"
            ? "oldest-first"
            : "newest-first";
  setStatus(`Flashcards set to ${modeLabel} review.`);
}

async function loadGoogleApiKey() {
  const data = await withPopupContext(() => chrome.storage.local.get(["googleApiKey"]), null);
  if (!data) return;
  state.googleApiKey = data.googleApiKey || "";
  el.googleApiKey.value = state.googleApiKey;
}

async function saveGoogleApiKey() {
  const key = el.googleApiKey.value.trim();
  state.googleApiKey = key;
  await withPopupContext(() => chrome.storage.local.set({ googleApiKey: key }), null);
  if (!popupContextAvailable) return;
  setStatus(key ? "Google API key saved." : "Google API key cleared.");
}

async function clearGoogleApiKey() {
  state.googleApiKey = "";
  el.googleApiKey.value = "";
  await withPopupContext(() => chrome.storage.local.remove(["googleApiKey"]), null);
  if (!popupContextAvailable) return;
  setStatus("Google API key removed.");
}

async function loadMerriamWebsterSettings() {
  const data = await withPopupContext(() => chrome.storage.local.get(["merriamWebsterApiKey"]), null);
  if (!data) return;

  state.merriamWebsterApiKey = data.merriamWebsterApiKey || "";
  el.merriamWebsterApiKey.value = state.merriamWebsterApiKey;
}

async function saveMerriamWebsterSettings() {
  const apiKey = el.merriamWebsterApiKey.value.trim();

  state.merriamWebsterApiKey = apiKey;

  await withPopupContext(() => chrome.storage.local.set({ merriamWebsterApiKey: apiKey }), null);
  if (!popupContextAvailable) return;

  if (state.translated.trim()) {
    resetSynonymOutput(READY_THESAURUS_MESSAGE);
    setThesaurusButtonState({ disabled: false });
  }

  setStatus(apiKey ? "Merriam-Webster API key saved." : "Merriam-Webster API key cleared.");
}

async function clearMerriamWebsterSettings() {
  state.merriamWebsterApiKey = "";
  el.merriamWebsterApiKey.value = "";
  await withPopupContext(() => chrome.storage.local.remove(["merriamWebsterApiKey"]), null);
  if (!popupContextAvailable) return;

  resetSynonymOutput("Add a Merriam-Webster API key in Settings to load synonyms or antonyms.");
  setStatus("Merriam-Webster API key removed.");
}

async function loadSynonymsForCurrentTranslation(type = "synonyms") {
  const normalizedText = el.sourceText.value.trim();
  const sourceLang = state.sourceLang;
  const targetLang = state.targetLang;
  const thesaurusLabel = getThesaurusLabel(type);
  const thesaurusSingularLabel = getThesaurusSingularLabel(type).toLowerCase();

  if (state.thesaurusVisibleType === type) {
    hideSynonymPanel();
    return;
  }

  if (getThesaurusLoaded(type)) {
    showCachedSynonymPanel(type);
    return;
  }

  if (!normalizedText || !state.translated.trim()) {
    resetSynonymOutput(DEFAULT_THESAURUS_MESSAGE);
    setStatus("Translate text first.", true);
    return;
  }

  if (!state.merriamWebsterApiKey) {
    showSynonymPanel(type);
    renderSynonymMessage(type, "Add a Merriam-Webster API key in Settings to load synonyms or antonyms.");
    setThesaurusButtonState({ disabled: false });
    return;
  }

  if (!state.googleApiKey) {
    showSynonymPanel(type);
    renderSynonymMessage(type, "Add a Google API key in Settings to translate thesaurus results.");
    setThesaurusButtonState({ disabled: false });
    return;
  }

  if (!sourceLang || sourceLang === "auto") {
    showSynonymPanel(type);
    renderSynonymMessage(type, `${thesaurusLabel} need a detected source language.`);
    setThesaurusButtonState({ disabled: false });
    return;
  }

  if (sourceLang !== "en") {
    showSynonymPanel(type);
    renderSynonymMessage(type, `${thesaurusLabel} are available only when the original text is English.`);
    setThesaurusButtonState({ disabled: false });
    return;
  }

  if (!targetLang || targetLang === "auto") {
    showSynonymPanel(type);
    renderSynonymMessage(type, `${thesaurusLabel} need a specific target language.`);
    setThesaurusButtonState({ disabled: false });
    return;
  }

  showSynonymPanel(type);
  setThesaurusButtonState({ disabled: true, loadingType: type });
  renderSynonymMessage(type, `Loading ${thesaurusLabel.toLowerCase()}...`);

  try {
    const thesaurusItems =
      type === "antonyms"
        ? await lookupSourceAntonyms({
            text: normalizedText,
            apiKey: state.merriamWebsterApiKey
          })
        : await lookupSourceSynonyms({
            text: normalizedText,
            apiKey: state.merriamWebsterApiKey
          });

    if (!thesaurusItems.length) {
      setThesaurusItems(type, []);
      setThesaurusLoaded(type, true);
      state.thesaurusPage = 1;
      renderSynonymMessage(type, `No ${thesaurusSingularLabel} suggestions found for this text.`);
      return;
    }

    let translatedMeanings;
    try {
      translatedMeanings = await translateTextList({
        texts: thesaurusItems,
        source: sourceLang,
        target: targetLang,
        apiKey: state.googleApiKey
      });
    } catch (error) {
      throw new Error(`Google thesaurus translation failed: ${error?.message || "Unknown error"}`);
    }

    const thesaurusRows = thesaurusItems.map((term, index) => ({
      sourceText: term,
      translatedText: translatedMeanings[index] || ""
    }));

    setThesaurusItems(type, thesaurusRows);
    setThesaurusLoaded(type, true);
    state.thesaurusTargetLang = targetLang;
    state.thesaurusPage = 1;
    renderSynonymResults(type, thesaurusRows, targetLang);
    setStatus(`${thesaurusLabel} loaded.`);
  } catch (error) {
    const message = String(error?.message || "");
    const normalizedMessage = message.toLowerCase();

    if (normalizedMessage.includes("suggestions:")) {
      renderSynonymMessage(type, message);
      return;
    }

    if (
      normalizedMessage.includes("google thesaurus translation failed")
    ) {
      renderSynonymMessage(type, "Google could not translate the thesaurus results right now.");
      return;
    }

    if (
      normalizedMessage.includes("merriam-webster api key") ||
      normalizedMessage.includes("thesaurus lookup failed") ||
      normalizedMessage.includes("access denied") ||
      normalizedMessage.includes("401") ||
      normalizedMessage.includes("403")
    ) {
      renderSynonymMessage(type, "Check the Merriam-Webster API key in Settings.");
      return;
    }

    if (normalizedMessage.includes("english")) {
      renderSynonymMessage(type, `${thesaurusLabel} are available only when the original text is English.`);
      return;
    }

    if (normalizedMessage.includes("no thesaurus entry")) {
      renderSynonymMessage(type, `No ${thesaurusSingularLabel} suggestions found for this text.`);
      return;
    }

    renderSynonymMessage(type, `${thesaurusLabel} could not be loaded right now.`);
  } finally {
    setThesaurusButtonState({ disabled: !state.translated.trim() });
  }
}

async function translateCurrentText() {
  const text = el.sourceText.value.trim();
  if (!text) {
    setStatus("Please enter text to translate.", true);
    return;
  }

  const sourceLang = el.sourceLang.value;
  const targetLang = el.targetLang.value;

  if (targetLang === "auto") {
    setStatus('Target language cannot be "Auto Detect".', true);
    return;
  }

  if (sourceLang === targetLang) {
    setStatus("Choose different source and target languages.", true);
    return;
  }

  setStatus("Translating...");

  try {
    const translation = await translateTextDetailed({
      text,
      source: sourceLang,
      target: targetLang,
      apiKey: state.googleApiKey
    });

    const translated = translation.translatedText || "";
    const detectedSourceLanguage = translation.detectedSourceLanguage || "";
    const effectiveSourceLang = sourceLang === "auto" ? detectedSourceLanguage || sourceLang : sourceLang;

    state.translated = translated;
    state.sourceLang = effectiveSourceLang;
    state.targetLang = targetLang;
    el.translatedText.value = translated;
    updateTranslateSaveButtonState();
    resetSynonymOutput(READY_THESAURUS_MESSAGE);
    setThesaurusButtonState({ disabled: !translated });
    schedulePopupResize();
    setStatus("Translation completed.");
  } catch (error) {
    if (isTranslationEditable()) {
      resetSynonymOutput("Synonyms and antonyms update after the next translation.");
      setThesaurusButtonState({ disabled: !getCurrentTranslatedText() });
      updateTranslateSaveButtonState();
    } else {
      resetTranslateOutputs();
    }
    setStatus(error?.message || "Translation failed.", true);
  }
}

async function saveCurrentTranslation() {
  const sourceText = el.sourceText.value.trim();
  const translatedText = getCurrentTranslatedText();

  if (!sourceText || !translatedText) {
    setStatus(
      isEditingDeckItem()
        ? "Enter both source and translated text before updating."
        : isEditingTranslationDraft()
          ? "Enter both source and translated text before saving."
          : "Translate text before saving.",
      true
    );
    return;
  }

  if (isEditingDeckItem()) {
    const existingItem = await getDeckItem(state.editingDeckItemId);
    if (!existingItem) {
      exitDeckEditMode();
      resetTranslateOutputs();
      updateClearSourceTextButtonState();
      setStatus("The selected deck item no longer exists.", true);
      return;
    }

    const updatedItem = {
      ...existingItem,
      sourceText,
      translatedText,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang
    };

    const { item: savedItem, revision } = await upsertDeckItem(updatedItem);
    state.selectedDeckIds = new Set([savedItem.id]);
    await syncDeckViewsAfterMutation({ deckRevision: revision });
    if (!popupContextAvailable) return;

    exitDeckEditMode();
    el.sourceText.value = "";
    resetTranslateOutputs();
    updateClearSourceTextButtonState();
    switchTab("deck");
    showSaveToast("Deck item updated.");
    setStatus("Deck item updated.");
    return;
  }

  const item = createDeckItem({
    sourceText,
    translatedText,
    sourceLang: state.sourceLang,
    targetLang: state.targetLang
  });

  const { revision } = await upsertDeckItem(item);
  await syncDeckViewsAfterMutation({
    deckRevision: revision,
    resetDeckPage: true
  });
  if (!popupContextAvailable) return;
  showSaveToast("Added to Deck successfully.");
  setStatus("Saved to deck.");
}

function pruneDeckSelection() {
  const deckIds = new Set(state.deck.map((item) => item.id));
  state.selectedDeckIds = new Set([...state.selectedDeckIds].filter((id) => deckIds.has(id)));

  if (state.editingDeckItemId && !deckIds.has(state.editingDeckItemId)) {
    exitDeckEditMode();
    el.sourceText.value = "";
    resetTranslateOutputs();
    updateClearSourceTextButtonState();
  }
}

function updateDeckToolbarState() {
  const selectedCount = state.selectedDeckIds.size;
  const hasSelection = selectedCount > 0;
  const hasDeckItems = state.deckTotalCount > 0;

  el.deckDeleteToolbarBtn.disabled = !hasSelection;
  el.deckModifyToolbarBtn.disabled = selectedCount !== 1;
  el.exportDeckBtn.disabled = !hasDeckItems;
}

function editSelectedDeckItem() {
  if (state.selectedDeckIds.size !== 1) {
    setStatus("Select exactly one card to modify.", true);
    return;
  }

  const [selectedId] = [...state.selectedDeckIds];
  const selectedItem = state.deck.find((item) => item.id === selectedId);
  if (!selectedItem) {
    setStatus("The selected card could not be found.", true);
    return;
  }

  enterDeckEditMode(selectedItem);
  setStatus("Editing selected deck item.");
}

async function importDeckItems() {
  const file = await chooseDeckImportFile();
  const fileText = await file.text();
  const { items: importedItems, format: detectedFormat } = autoParseDeckImportText(fileText, file.name);

  if (!importedItems.length) {
    throw new Error("No valid cards found in the selected file.");
  }

  const existingItems = await listAllDeckItems();
  const { mergedDeck, importedCount, skippedCount } = mergeImportedDeckItems(existingItems, importedItems);
  if (!importedCount) {
    setStatus(
      skippedCount ? "No new cards imported. Matching cards were skipped." : "No valid cards found in the selected file.",
      true
    );
    return;
  }

  state.selectedDeckIds.clear();
  const { revision } = await replaceDeckItems(mergedDeck);
  await syncDeckViewsAfterMutation({
    deckRevision: revision,
    resetDeckPage: true
  });
  if (!popupContextAvailable) return;

  const formatLabel = DECK_TRANSFER_FORMATS[detectedFormat]?.label || "file";
  const skippedLabel = skippedCount ? ` Skipped ${formatItemCountLabel(skippedCount)} already in deck.` : "";
  setStatus(`Imported ${formatItemCountLabel(importedCount)} from ${formatLabel}.${skippedLabel}`);
}

async function exportDeckItems() {
  const exportItems = sortDeckItemsByNewest(await listAllDeckItems());
  if (!exportItems.length) {
    setStatus("No cards to export.", true);
    return;
  }

  const format = await saveDeckExportFile(exportItems);
  if (!popupContextAvailable) return;

  setStatus(`Exported ${formatItemCountLabel(exportItems.length)} as ${DECK_TRANSFER_FORMATS[format].label}.`);
}

async function deleteSelectedDeckItems() {
  const selectedCount = state.selectedDeckIds.size;
  if (!selectedCount) return;

  const editingItemDeleted = isEditingDeckItem() && state.selectedDeckIds.has(state.editingDeckItemId);
  const selectedIds = [...state.selectedDeckIds];
  const { revision } = await deleteDeckItems(selectedIds);
  state.selectedDeckIds.clear();
  if (editingItemDeleted) {
    exitDeckEditMode();
    el.sourceText.value = "";
    resetTranslateOutputs();
    updateClearSourceTextButtonState();
  }
  await syncDeckViewsAfterMutation({ deckRevision: revision });
  setStatus(`${formatItemCountLabel(selectedCount)} deleted.`);
}

async function loadHighlightSetting() {
  const data = await withPopupContext(
    () => chrome.storage.local.get(["highlightEnabled", "highlightBlockedUrls"]),
    null
  );
  if (!data) return;
  el.highlightEnabled.checked = data.highlightEnabled !== false;
  state.highlightBlockedUrls = Array.isArray(data.highlightBlockedUrls)
    ? [...new Set(data.highlightBlockedUrls.map((rule) => normalizeHighlightBlockedUrlRule(rule)).filter(Boolean))]
    : [];
  renderHighlightBlockedUrlList();
}

async function saveHighlightSetting(enabled) {
  await withPopupContext(() => chrome.storage.local.set({ highlightEnabled: enabled }), null);
}

async function saveHighlightBlockedUrls() {
  await withPopupContext(() => chrome.storage.local.set({ highlightBlockedUrls: state.highlightBlockedUrls }), null);
}

async function addHighlightBlockedUrlRule() {
  const normalizedRule = normalizeHighlightBlockedUrlRule(el.highlightBlockUrlInput.value);
  if (!normalizedRule) {
    setStatus("Enter a URL or domain to block highlighting.", true);
    return;
  }

  if (state.highlightBlockedUrls.includes(normalizedRule)) {
    setStatus("That URL rule is already in the block list.", true);
    return;
  }

  state.highlightBlockedUrls = [...state.highlightBlockedUrls, normalizedRule];
  el.highlightBlockUrlInput.value = "";
  renderHighlightBlockedUrlList();
  await saveHighlightBlockedUrls();
  if (!popupContextAvailable) return;
  setStatus("Highlight block rule added.");
}

async function removeHighlightBlockedUrlRule(rule) {
  const normalizedRule = normalizeHighlightBlockedUrlRule(rule);
  const nextRules = state.highlightBlockedUrls.filter((entry) => entry !== normalizedRule);
  if (nextRules.length === state.highlightBlockedUrls.length) return;

  state.highlightBlockedUrls = nextRules;
  renderHighlightBlockedUrlList();
  await saveHighlightBlockedUrls();
  if (!popupContextAvailable) return;
  setStatus("Highlight block rule removed.");
}

function focusTranslateInputForManualAdd() {
  if (isEditingDeckItem()) {
    exitDeckEditMode();
    el.sourceText.value = "";
    resetTranslateOutputs();
    updateClearSourceTextButtonState();
  }

  switchTab("translate");
  focusSourceText();
  setStatus("Translate tab ready for manual card entry.");
}

function handleDeckToolbarAction(action) {
  if (action === "add-manual") {
    focusTranslateInputForManualAdd();
    return;
  }
}

async function goToDeckPage(nextPage) {
  state.deckPage = Math.max(1, nextPage);
  await refreshDeck();
}

function handleFlashcardKeyDown(event) {
  if (getActivePopupTabName() !== "flashcards") return;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;

  const target = event.target;
  if (isFormField(target)) return;

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goToPreviousFlashcard();
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    goToNextFlashcard();
    return;
  }

  if (event.code === "Space" || event.key === " ") {
    event.preventDefault();
    toggleFlashcardFace();
  }
}

function bindEvents() {
  el.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      switchTab(tabName, {
        focusDeckSearch: tabName === "deck",
        focusTranslateInput: tabName === "translate"
      });

      if (tabName === "flashcards") {
        Promise.resolve(loadFlashcardDeck()).catch((error) => {
          handlePopupAsyncError(error, "Could not load flashcards.");
        });
      }
    });
  });

  bindAsyncEvent(el.translateBtn, "click", translateCurrentText, "Translation failed.");
  bindAsyncEvent(el.saveBtn, "click", saveCurrentTranslation, "Could not save translation.");
  el.modifyBtn.addEventListener("click", enterTranslationDraftEditMode);
  bindAsyncEvent(el.flashcardOrderMode, "change", changeFlashcardOrderMode, "Could not update flashcard order.");
  el.flashcardCard.addEventListener("click", toggleFlashcardFace);
  el.flashcardPrevBtn.addEventListener("click", goToPreviousFlashcard);
  el.flashcardNextBtn.addEventListener("click", goToNextFlashcard);
  bindAsyncEvent(el.loadSynonymsBtn, "click", () => loadSynonymsForCurrentTranslation("synonyms"), "Could not load synonyms.");
  bindAsyncEvent(el.loadAntonymsBtn, "click", () => loadSynonymsForCurrentTranslation("antonyms"), "Could not load antonyms.");
  el.synonymPrevPageBtn.addEventListener("click", () => goToSynonymPage(state.thesaurusPage - 1));
  el.synonymNextPageBtn.addEventListener("click", () => goToSynonymPage(state.thesaurusPage + 1));
  el.swapLangBtn.addEventListener("click", swapSelectedLanguages);
  el.clearSourceTextBtn.addEventListener("click", clearSourceText);
  bindAsyncEvent(el.clearDeckSearchBtn, "click", clearDeckSearch, "Could not clear deck search.");

  el.sourceText.addEventListener("input", handleTranslateInputsChanged);
  el.translatedText.addEventListener("input", handleTranslatedTextChanged);
  el.sourceText.addEventListener("keydown", handleSourceTextKeyDown);
  el.sourceLang.addEventListener("change", () => {
    updateSwapLanguageButtonState();
    handleTranslateInputsChanged();
  });
  el.targetLang.addEventListener("change", () => {
    updateSwapLanguageButtonState();
    handleTranslateInputsChanged();
  });

  el.deckAddManualBtn.addEventListener("click", () => handleDeckToolbarAction("add-manual"));
  bindAsyncEvent(el.deckDeleteToolbarBtn, "click", deleteSelectedDeckItems, "Could not delete deck items.");
  bindAsyncEvent(el.deckModifyToolbarBtn, "click", editSelectedDeckItem, "Could not load deck item for editing.");
  el.deckSearch.addEventListener("input", () => {
    state.deckPage = 1;
    updateClearDeckSearchButtonState();
    Promise.resolve(refreshDeck()).catch((error) => {
      handlePopupAsyncError(error, "Could not search deck items.");
    });
  });
  el.deckSort.addEventListener("change", () => {
    state.deckSort = el.deckSort.value;
    state.deckPage = 1;
    Promise.resolve(refreshDeck()).catch((error) => {
      handlePopupAsyncError(error, "Could not update deck sort.");
    });
    renderFlashcard();
  });
  bindAsyncEvent(el.deckPrevPageBtn, "click", () => goToDeckPage(state.deckPage - 1), "Could not load the previous deck page.");
  bindAsyncEvent(el.deckNextPageBtn, "click", () => goToDeckPage(state.deckPage + 1), "Could not load the next deck page.");
  bindAsyncEvent(el.refreshDeckBtn, "click", refreshDeck, "Could not refresh deck.");
  bindAsyncEvent(el.importDeckBtn, "click", importDeckItems, "Could not import deck file.");
  bindAsyncEvent(el.exportDeckBtn, "click", exportDeckItems, "Could not export deck file.");

  bindAsyncEvent(el.saveApiKeyBtn, "click", saveGoogleApiKey, "Could not save API key.");
  bindAsyncEvent(el.clearApiKeyBtn, "click", clearGoogleApiKey, "Could not clear API key.");
  bindAsyncEvent(el.saveMerriamWebsterBtn, "click", saveMerriamWebsterSettings, "Could not save thesaurus API key.");
  bindAsyncEvent(el.clearMerriamWebsterBtn, "click", clearMerriamWebsterSettings, "Could not clear thesaurus API key.");

  el.deckList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.classList.contains("deck-item-check")) {
      const id = target.dataset.id;
      if (!id) return;

      const checkbox = target;
      if (!(checkbox instanceof HTMLInputElement)) return;

      if (checkbox.checked) {
        state.selectedDeckIds.add(id);
      } else {
        state.selectedDeckIds.delete(id);
      }

      const deckItem = checkbox.closest(".deck-item");
      deckItem?.classList.toggle("selected", checkbox.checked);
      updateDeckToolbarState();
    }
  });

  bindAsyncEvent(el.importDbBtn, "click", async () => {
    try {
      await importDeckItems();
      await refreshDatabaseLocationLabel();
    } catch (error) {
      setStatus(error?.message || "Could not import database file.", true);
    }
  }, "Could not import database file.");

  bindAsyncEvent(el.chooseDbSyncBtn, "click", async () => {
    try {
      await chooseDatabaseSyncFile();
      await clearDatabaseLastSyncTime();
      await refreshDatabaseLocationLabel();
      setStatus("Database sync file selected successfully.");
    } catch (error) {
      setStatus(error?.message || "Could not select database sync file.", true);
    }
  }, "Could not select database sync file.");

  bindAsyncEvent(el.syncDbBtn, "click", async () => {
    try {
      const result = await runDatabaseSyncNow();
      await refreshDatabaseLocationLabel();
      setStatus(`Synced ${formatItemCountLabel(result.count)} to ${result.fileName}.`);
    } catch (error) {
      setStatus(error?.message || "Could not sync database file.", true);
    }
  }, "Could not sync database file.");

  bindAsyncEvent(el.highlightEnabled, "change", async () => {
    await saveHighlightSetting(el.highlightEnabled.checked);
    if (!popupContextAvailable) return;
    setStatus(`Highlight ${el.highlightEnabled.checked ? "enabled" : "disabled"}.`);
  }, "Could not update highlight setting.");

  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[DATABASE_LAST_SYNC_AT_KEY]) return;

      Promise.resolve(refreshDatabaseLocationLabel()).catch((error) => {
        handlePopupAsyncError(error, "Could not refresh database sync status.");
      });
    });
  }

  bindAsyncEvent(el.addHighlightBlockUrlBtn, "click", addHighlightBlockedUrlRule, "Could not add highlight block rule.");
  el.highlightBlockUrlInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    Promise.resolve(addHighlightBlockedUrlRule()).catch((error) => {
      handlePopupAsyncError(error, "Could not add highlight block rule.");
    });
  });
  el.highlightBlockUrlList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const removeButton = target.closest(".highlight-block-remove");
    if (!(removeButton instanceof HTMLButtonElement)) return;

    Promise.resolve(removeHighlightBlockedUrlRule(removeButton.dataset.rule || "")).catch((error) => {
      handlePopupAsyncError(error, "Could not remove highlight block rule.");
    });
  });
  document.addEventListener("keydown", handleFlashcardKeyDown);
}

async function init() {
  await initializeDatabase();
  renderLanguages();
  syncTranslatedTextEditableState();
  updateSaveButtonLabel();
  resetTranslateOutputs();
  updateClearSourceTextButtonState();
  updateClearDeckSearchButtonState();
  el.deckSort.value = state.deckSort;
  bindEvents();
  updateDeckToolbarState();
  switchTab("translate");
  await Promise.all([
    refreshDeck(),
    refreshDatabaseLocationLabel(),
    loadFlashcardSettings(),
    loadHighlightSetting(),
    loadGoogleApiKey(),
    loadMerriamWebsterSettings()
  ]);
  const loadedSelection = await fillTranslateFromActiveTabSelection();
  if (!loadedSelection) {
    setStatus("Ready.");
  }
  schedulePopupResize();
  focusSourceText(true);
}

init().catch((error) => {
  handlePopupAsyncError(error, "Initialization failed.");
});

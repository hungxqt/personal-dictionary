import { LANGUAGES } from "../lib/languages.js";
import { lookupSourceSynonyms, translateTextDetailed, translateTextList } from "../lib/translator.js";
import {
  initializeDatabase,
  chooseCustomDatabaseFile,
  useDefaultDatabaseLocation,
  getDatabaseLocationInfo,
  readDeckItems,
  writeDeckItems,
  createDeckItem
} from "../lib/database.js";

const state = {
  translated: "",
  sourceLang: "en",
  targetLang: "vi",
  synonyms: [],
  synonymsLoaded: false,
  synonymsVisible: false,
  synonymStatusMessage: "",
  synonymTargetLang: "vi",
  synonymPage: 1,
  synonymPageSize: 5,
  deck: [],
  selectedDeckIds: new Set(),
  deckClipboard: [],
  deckSort: "newest",
  deckPage: 1,
  deckPageSize: 10,
  googleApiKey: "",
  microsoftTranslatorApiKey: "",
  microsoftTranslatorRegion: "",
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
const DEFAULT_SYNONYM_MESSAGE = "Translate text first, then click Synonyms.";
const READY_SYNONYM_MESSAGE = "Click Synonyms to load suggestions.";

const el = {
  app: document.querySelector(".app"),
  tabButtons: document.querySelectorAll(".tab-btn"),
  tabPanels: document.querySelectorAll(".tab-panel"),
  sourceLang: document.getElementById("sourceLang"),
  targetLang: document.getElementById("targetLang"),
  swapLangBtn: document.getElementById("swapLangBtn"),
  sourceText: document.getElementById("sourceText"),
  translatedText: document.getElementById("translatedText"),
  loadSynonymsBtn: document.getElementById("loadSynonymsBtn"),
  synonymResults: document.getElementById("synonymResults"),
  synonymPagination: document.getElementById("synonymPagination"),
  synonymPrevPageBtn: document.getElementById("synonymPrevPageBtn"),
  synonymNextPageBtn: document.getElementById("synonymNextPageBtn"),
  synonymPaginationLabel: document.getElementById("synonymPaginationLabel"),
  translateBtn: document.getElementById("translateBtn"),
  saveBtn: document.getElementById("saveBtn"),
  deckSearch: document.getElementById("deckSearch"),
  deckAddManualBtn: document.getElementById("deckAddManualBtn"),
  deckDeleteToolbarBtn: document.getElementById("deckDeleteToolbarBtn"),
  deckCutToolbarBtn: document.getElementById("deckCutToolbarBtn"),
  deckPasteToolbarBtn: document.getElementById("deckPasteToolbarBtn"),
  deckSort: document.getElementById("deckSort"),
  importDeckBtn: document.getElementById("importDeckBtn"),
  exportDeckBtn: document.getElementById("exportDeckBtn"),
  deckImportInput: document.getElementById("deckImportInput"),
  deckList: document.getElementById("deckList"),
  deckPrevPageBtn: document.getElementById("deckPrevPageBtn"),
  deckNextPageBtn: document.getElementById("deckNextPageBtn"),
  deckPaginationLabel: document.getElementById("deckPaginationLabel"),
  refreshDeckBtn: document.getElementById("refreshDeckBtn"),
  googleApiKey: document.getElementById("googleApiKey"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  clearApiKeyBtn: document.getElementById("clearApiKeyBtn"),
  microsoftTranslatorApiKey: document.getElementById("microsoftTranslatorApiKey"),
  microsoftTranslatorRegion: document.getElementById("microsoftTranslatorRegion"),
  saveMicrosoftTranslatorBtn: document.getElementById("saveMicrosoftTranslatorBtn"),
  clearMicrosoftTranslatorBtn: document.getElementById("clearMicrosoftTranslatorBtn"),
  dbSummaryLabel: document.getElementById("dbSummaryLabel"),
  dbLocationLabel: document.getElementById("dbLocationLabel"),
  useDefaultDbBtn: document.getElementById("useDefaultDbBtn"),
  chooseDbBtn: document.getElementById("chooseDbBtn"),
  highlightEnabled: document.getElementById("highlightEnabled"),
  highlightBlockUrlInput: document.getElementById("highlightBlockUrlInput"),
  addHighlightBlockUrlBtn: document.getElementById("addHighlightBlockUrlBtn"),
  highlightBlockUrlList: document.getElementById("highlightBlockUrlList"),
  applyHighlightToTabBtn: document.getElementById("applyHighlightToTabBtn"),
  saveToast: document.getElementById("saveToast"),
  status: document.getElementById("status")
};

let popupContextAvailable = true;
let popupResizeFrame = 0;
let saveToastTimeoutId = 0;

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
  if (!popupContextAvailable || !el.status) return;
  el.status.textContent = message;
  el.status.style.color = isError ? "#b42318" : "#245f5a";
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

function setSynonymButtonState({ disabled = true, loading = false } = {}) {
  el.loadSynonymsBtn.disabled = disabled;
  if (loading) {
    el.loadSynonymsBtn.textContent = "Loading...";
    return;
  }

  if (state.synonymsVisible) {
    el.loadSynonymsBtn.textContent = "Hide Synonyms";
    return;
  }

  el.loadSynonymsBtn.textContent = state.synonymsLoaded ? "Show Synonyms" : "Synonyms";
}

function updateSynonymPagination(totalItems) {
  const pageSize = state.synonymPageSize;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 1;
  state.synonymPage = Math.min(Math.max(state.synonymPage, 1), totalPages);

  if (!totalItems) {
    el.synonymPagination.hidden = true;
    el.synonymPaginationLabel.textContent = "0 - 0 of 0";
    el.synonymPrevPageBtn.disabled = true;
    el.synonymNextPageBtn.disabled = true;
    return { startIndex: 0, endIndex: 0 };
  }

  const startIndex = (state.synonymPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  el.synonymPagination.hidden = totalItems <= pageSize;
  el.synonymPaginationLabel.textContent = `${startIndex + 1} - ${endIndex} of ${totalItems}`;
  el.synonymPrevPageBtn.disabled = state.synonymPage <= 1;
  el.synonymNextPageBtn.disabled = state.synonymPage >= totalPages;

  return { startIndex, endIndex };
}

function showSynonymPanel() {
  state.synonymsVisible = true;
  el.synonymResults.hidden = false;
  el.app?.classList.add("synonym-open");
}

function hideSynonymPanel() {
  state.synonymsVisible = false;
  el.synonymResults.hidden = true;
  el.synonymPagination.hidden = true;
  el.app?.classList.remove("synonym-open");
  setSynonymButtonState({ disabled: !state.translated.trim() });
  schedulePopupResize();
}

function renderSynonymMessage(message = DEFAULT_SYNONYM_MESSAGE) {
  state.synonymStatusMessage = message;
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

function renderSynonymResults(items, targetLang) {
  if (!items.length) {
    renderSynonymMessage("No synonym suggestions found for this text.");
    return;
  }

  const { startIndex, endIndex } = updateSynonymPagination(items.length);
  const pageItems = items.slice(startIndex, endIndex);

  const header = document.createElement("div");
  header.className = "synonym-results-head";

  const sourceLabel = document.createElement("div");
  sourceLabel.textContent = "Synonym";

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

function resetSynonymOutput(message = DEFAULT_SYNONYM_MESSAGE) {
  state.synonyms = [];
  state.synonymsLoaded = false;
  state.synonymsVisible = false;
  state.synonymStatusMessage = message;
  state.synonymPage = 1;
  hideSynonymPanel();
}

function goToSynonymPage(nextPage) {
  state.synonymPage = Math.max(1, nextPage);
  renderSynonymResults(state.synonyms, state.synonymTargetLang);
}

function showCachedSynonymPanel() {
  showSynonymPanel();
  if (state.synonyms.length) {
    renderSynonymResults(state.synonyms, state.synonymTargetLang);
  } else {
    renderSynonymMessage(state.synonymStatusMessage || DEFAULT_SYNONYM_MESSAGE);
  }
  setSynonymButtonState({ disabled: !state.translated.trim() });
}

function resetTranslationOutput(placeholder = DEFAULT_TRANSLATED_PLACEHOLDER) {
  state.translated = "";
  el.translatedText.value = "";
  el.translatedText.placeholder = placeholder;
  el.saveBtn.disabled = true;
}

function resetTranslateOutputs({
  translatedPlaceholder = DEFAULT_TRANSLATED_PLACEHOLDER,
  synonymMessage = DEFAULT_SYNONYM_MESSAGE
} = {}) {
  resetTranslationOutput(translatedPlaceholder);
  resetSynonymOutput(synonymMessage);
  setSynonymButtonState({ disabled: true });
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
    const handleChange = () => {
      const [file] = el.deckImportInput.files || [];
      el.deckImportInput.value = "";
      if (file) {
        resolve(file);
      } else {
        reject(new DOMException("The user aborted a request.", "AbortError"));
      }
    };

    el.deckImportInput.addEventListener("change", handleChange, { once: true });
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

function switchTab(tabName) {
  el.tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle("active", active);
  });

  el.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });

  schedulePopupResize();
}

function updateSwapLanguageButtonState() {
  if (!el.swapLangBtn) return;

  const disabled = el.sourceLang.value === "auto";
  el.swapLangBtn.disabled = disabled;
  el.swapLangBtn.title = disabled ? 'Choose a specific "From" language to enable switching.' : "Swap languages";
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
    resetSynonymOutput("Synonyms update after the next translation.");
    setSynonymButtonState({ disabled: true });
    el.saveBtn.disabled = !state.translated;
  } else {
    resetTranslateOutputs();
  }

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
  setStatus("Selected text loaded into Translate.");
  return true;
}

function handleTranslateInputsChanged() {
  state.sourceLang = el.sourceLang.value;
  state.targetLang = el.targetLang.value;
  resetTranslateOutputs();
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

function sortDeckItems(items, sortOrder = state.deckSort) {
  const sortedItems = [...items];

  sortedItems.sort((left, right) => {
    if (sortOrder === "oldest") {
      const timestampDiff = getDeckItemTimestamp(left) - getDeckItemTimestamp(right);
      if (timestampDiff !== 0) return timestampDiff;
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    }

    if (sortOrder === "source-asc") {
      const sourceDiff = String(left?.sourceText || "").localeCompare(String(right?.sourceText || ""));
      if (sourceDiff !== 0) return sourceDiff;
      return getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    }

    if (sortOrder === "source-desc") {
      const sourceDiff = String(right?.sourceText || "").localeCompare(String(left?.sourceText || ""));
      if (sourceDiff !== 0) return sourceDiff;
      return getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    }

    const timestampDiff = getDeckItemTimestamp(right) - getDeckItemTimestamp(left);
    if (timestampDiff !== 0) return timestampDiff;
    return String(right?.id || "").localeCompare(String(left?.id || ""));
  });

  return sortedItems;
}

function getFilteredDeckItems(items = state.deck) {
  const sortedItems = sortDeckItems(items);
  const query = el.deckSearch.value.trim().toLowerCase();

  const filteredItems = sortedItems.filter((item) => {
    if (!query) return true;
    return (
      item.sourceText.toLowerCase().includes(query) ||
      item.translatedText.toLowerCase().includes(query) ||
      item.sourceLang.toLowerCase().includes(query) ||
      item.targetLang.toLowerCase().includes(query)
    );
  });

  return { filteredItems, query };
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
  const { filteredItems, query } = getFilteredDeckItems(items);
  updateDeckPagination(filteredItems.length);

  if (!filteredItems.length) {
    el.deckList.innerHTML = `<div class="deck-item">${query ? "No matching cards." : "No saved words yet."}</div>`;
    updateDeckToolbarState();
    schedulePopupResize();
    return;
  }

  const startIndex = (state.deckPage - 1) * state.deckPageSize;
  const pageItems = filteredItems.slice(startIndex, startIndex + state.deckPageSize);

  const html = pageItems
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
  state.deck = sortDeckItemsByNewest(await readDeckItems());
  pruneDeckSelection();
  renderDeck();
}

async function refreshDatabaseLocationLabel() {
  const info = await getDatabaseLocationInfo();
  el.dbSummaryLabel.textContent = info.summary;
  el.dbLocationLabel.textContent = info.detail;
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

async function loadMicrosoftTranslatorSettings() {
  const data = await withPopupContext(
    () => chrome.storage.local.get(["microsoftTranslatorApiKey", "microsoftTranslatorRegion"]),
    null
  );
  if (!data) return;

  state.microsoftTranslatorApiKey = data.microsoftTranslatorApiKey || "";
  state.microsoftTranslatorRegion = data.microsoftTranslatorRegion || "";
  el.microsoftTranslatorApiKey.value = state.microsoftTranslatorApiKey;
  el.microsoftTranslatorRegion.value = state.microsoftTranslatorRegion;
}

async function saveMicrosoftTranslatorSettings() {
  const apiKey = el.microsoftTranslatorApiKey.value.trim();
  const region = el.microsoftTranslatorRegion.value.trim();

  state.microsoftTranslatorApiKey = apiKey;
  state.microsoftTranslatorRegion = region;

  await withPopupContext(
    () =>
      chrome.storage.local.set({
        microsoftTranslatorApiKey: apiKey,
        microsoftTranslatorRegion: region
      }),
    null
  );
  if (!popupContextAvailable) return;

  setStatus(apiKey ? "Microsoft Translator settings saved." : "Microsoft Translator settings cleared.");
}

async function clearMicrosoftTranslatorSettings() {
  state.microsoftTranslatorApiKey = "";
  state.microsoftTranslatorRegion = "";
  el.microsoftTranslatorApiKey.value = "";
  el.microsoftTranslatorRegion.value = "";
  await withPopupContext(
    () => chrome.storage.local.remove(["microsoftTranslatorApiKey", "microsoftTranslatorRegion"]),
    null
  );
  if (!popupContextAvailable) return;

  resetSynonymOutput("Add a Microsoft Translator API key in Settings to load synonyms.");
  setStatus("Microsoft Translator settings removed.");
}

async function loadSynonymsForCurrentTranslation() {
  const normalizedText = el.sourceText.value.trim();
  const sourceLang = state.sourceLang;
  const targetLang = state.targetLang;

  if (state.synonymsVisible) {
    hideSynonymPanel();
    return;
  }

  if (state.synonymsLoaded) {
    showCachedSynonymPanel();
    return;
  }

  if (!normalizedText || !state.translated.trim()) {
    resetSynonymOutput(DEFAULT_SYNONYM_MESSAGE);
    setStatus("Translate text first.", true);
    return;
  }

  if (!state.microsoftTranslatorApiKey) {
    showSynonymPanel();
    renderSynonymMessage("Add a Microsoft Translator API key in Settings to load synonyms.");
    setSynonymButtonState({ disabled: false });
    return;
  }

  if (!sourceLang || sourceLang === "auto") {
    showSynonymPanel();
    renderSynonymMessage("Synonyms need a detected source language.");
    setSynonymButtonState({ disabled: false });
    return;
  }

  if (!targetLang || targetLang === "auto" || sourceLang === targetLang) {
    showSynonymPanel();
    renderSynonymMessage("Synonyms are unavailable for this language pair.");
    setSynonymButtonState({ disabled: false });
    return;
  }

  showSynonymPanel();
  setSynonymButtonState({ disabled: true, loading: true });
  renderSynonymMessage("Loading synonym suggestions...");

  try {
    const synonyms = await lookupSourceSynonyms({
      text: normalizedText,
      source: sourceLang,
      target: targetLang,
      apiKey: state.microsoftTranslatorApiKey,
      region: state.microsoftTranslatorRegion
    });

    if (!synonyms.length) {
      state.synonyms = [];
      state.synonymsLoaded = true;
      state.synonymPage = 1;
      renderSynonymMessage("No synonym suggestions found for this text.");
      return;
    }

    const translatedMeanings = await translateTextList({
      texts: synonyms,
      source: sourceLang,
      target: targetLang,
      apiKey: state.googleApiKey
    });

    const synonymRows = synonyms.map((synonym, index) => ({
      sourceText: synonym,
      translatedText: translatedMeanings[index] || ""
    }));

    state.synonyms = synonymRows;
    state.synonymsLoaded = true;
    state.synonymTargetLang = targetLang;
    state.synonymPage = 1;
    renderSynonymResults(synonymRows, targetLang);
    setStatus("Synonyms loaded.");
  } catch (error) {
    const message = String(error?.message || "");
    const normalizedMessage = message.toLowerCase();

    if (
      normalizedMessage.includes("dictionary") &&
      (
        normalizedMessage.includes("not supported") ||
        normalizedMessage.includes("unsupported") ||
        normalizedMessage.includes("language pair") ||
        normalizedMessage.includes("not valid")
      )
    ) {
      state.synonyms = [];
      state.synonymsLoaded = true;
      state.synonymPage = 1;
      renderSynonymMessage("Synonyms are unavailable for this language pair.");
      return;
    }

    if (
      normalizedMessage.includes("subscription") ||
      normalizedMessage.includes("authorization") ||
      normalizedMessage.includes("access denied") ||
      normalizedMessage.includes("401") ||
      normalizedMessage.includes("403") ||
      normalizedMessage.includes("region")
    ) {
      renderSynonymMessage("Check the Microsoft Translator key and region in Settings.");
      return;
    }

    renderSynonymMessage("Synonyms could not be loaded right now.");
  } finally {
    setSynonymButtonState({ disabled: !state.translated.trim() });
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
    el.saveBtn.disabled = !translated;
    resetSynonymOutput(READY_SYNONYM_MESSAGE);
    setSynonymButtonState({ disabled: !translated });
    schedulePopupResize();
    setStatus("Translation completed.");
  } catch (error) {
    resetTranslateOutputs();
    setStatus(error?.message || "Translation failed.", true);
  }
}

async function saveCurrentTranslation() {
  const sourceText = el.sourceText.value.trim();
  const translatedText = state.translated.trim();

  if (!sourceText || !translatedText) {
    setStatus("Translate text before saving.", true);
    return;
  }

  const item = createDeckItem({
    sourceText,
    translatedText,
    sourceLang: state.sourceLang,
    targetLang: state.targetLang
  });

  state.deck = sortDeckItemsByNewest([item, ...state.deck]);
  state.deckPage = 1;
  await writeDeckItems(state.deck);
  await withPopupContext(() => chrome.storage.local.set({ deckItems: state.deck }), null);
  if (!popupContextAvailable) return;
  renderDeck();
  showSaveToast("Added to Deck successfully.");
  setStatus("Saved to deck.");
}

function pruneDeckSelection() {
  const deckIds = new Set(state.deck.map((item) => item.id));
  state.selectedDeckIds = new Set([...state.selectedDeckIds].filter((id) => deckIds.has(id)));
}

function updateDeckToolbarState() {
  const hasSelection = state.selectedDeckIds.size > 0;
  const hasClipboard = state.deckClipboard.length > 0;
  const hasDeckItems = state.deck.length > 0;

  el.deckDeleteToolbarBtn.disabled = !hasSelection;
  el.deckCutToolbarBtn.disabled = !hasSelection;
  el.deckPasteToolbarBtn.disabled = !hasClipboard;
  el.exportDeckBtn.disabled = !hasDeckItems;
}

async function persistDeckState() {
  await writeDeckItems(state.deck);
  await withPopupContext(() => chrome.storage.local.set({ deckItems: state.deck }), null);
  if (!popupContextAvailable) return;
  renderDeck();
}

async function importDeckItems() {
  const file = await chooseDeckImportFile();
  const fileText = await file.text();
  const { items: importedItems, format: detectedFormat } = autoParseDeckImportText(fileText, file.name);

  if (!importedItems.length) {
    throw new Error("No valid cards found in the selected file.");
  }

  const { mergedDeck, importedCount, skippedCount } = mergeImportedDeckItems(state.deck, importedItems);
  if (!importedCount) {
    setStatus(
      skippedCount ? "No new cards imported. Matching cards were skipped." : "No valid cards found in the selected file.",
      true
    );
    return;
  }

  state.deck = sortDeckItemsByNewest(mergedDeck);
  state.deckPage = 1;
  pruneDeckSelection();
  await persistDeckState();
  if (!popupContextAvailable) return;

  const formatLabel = DECK_TRANSFER_FORMATS[detectedFormat]?.label || "file";
  const skippedLabel = skippedCount ? ` Skipped ${formatItemCountLabel(skippedCount)} already in deck.` : "";
  setStatus(`Imported ${formatItemCountLabel(importedCount)} from ${formatLabel}.${skippedLabel}`);
}

async function exportDeckItems() {
  if (!state.deck.length) {
    setStatus("No cards to export.", true);
    return;
  }

  const exportItems = sortDeckItemsByNewest(state.deck);
  const format = await saveDeckExportFile(exportItems);
  if (!popupContextAvailable) return;

  setStatus(`Exported ${formatItemCountLabel(exportItems.length)} as ${DECK_TRANSFER_FORMATS[format].label}.`);
}

async function deleteSelectedDeckItems() {
  const selectedCount = state.selectedDeckIds.size;
  if (!selectedCount) return;

  state.deck = sortDeckItemsByNewest(state.deck.filter((item) => !state.selectedDeckIds.has(item.id)));
  state.selectedDeckIds.clear();
  pruneDeckSelection();
  await persistDeckState();
  setStatus(`${formatItemCountLabel(selectedCount)} deleted.`);
}

async function cutSelectedDeckItems() {
  const selectedItems = state.deck.filter((item) => state.selectedDeckIds.has(item.id));
  if (!selectedItems.length) return;

  state.deckClipboard = selectedItems.map((item) => ({ ...item }));
  state.deck = sortDeckItemsByNewest(state.deck.filter((item) => !state.selectedDeckIds.has(item.id)));
  state.selectedDeckIds.clear();
  pruneDeckSelection();
  await persistDeckState();
  setStatus(`${formatItemCountLabel(selectedItems.length)} cut.`);
}

async function pasteDeckItems() {
  if (!state.deckClipboard.length) return;

  const clipboardItems = state.deckClipboard.map((item) => ({ ...item }));
  state.deck = sortDeckItemsByNewest([...clipboardItems, ...state.deck]);
  state.deckClipboard = [];
  state.deckPage = 1;
  pruneDeckSelection();
  await persistDeckState();
  setStatus(`${formatItemCountLabel(clipboardItems.length)} pasted.`);
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

async function applyHighlightToCurrentTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("No active tab found.", true);
    return;
  }

  try {
    const response = await withPopupContext(() => chrome.tabs.sendMessage(tab.id, { type: "refresh-highlight" }), null);
    if (!popupContextAvailable) return;
    if (!response?.ok) {
      throw new Error("Open a normal webpage tab first, then try again.");
    }
    setStatus("Applied highlight refresh to current tab.");
  } catch {
    setStatus("Open a normal webpage tab first, then try again.", true);
  }
}

function focusTranslateInputForManualAdd() {
  switchTab("translate");
  window.setTimeout(() => {
    el.sourceText.focus();
  }, 0);
  setStatus("Translate tab ready for manual card entry.");
}

function handleDeckToolbarAction(action) {
  if (action === "add-manual") {
    focusTranslateInputForManualAdd();
    return;
  }
}

function goToDeckPage(nextPage) {
  state.deckPage = Math.max(1, nextPage);
  renderDeck();
}

function bindEvents() {
  el.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  bindAsyncEvent(el.translateBtn, "click", translateCurrentText, "Translation failed.");
  bindAsyncEvent(el.saveBtn, "click", saveCurrentTranslation, "Could not save translation.");
  bindAsyncEvent(el.loadSynonymsBtn, "click", loadSynonymsForCurrentTranslation, "Could not load synonyms.");
  el.synonymPrevPageBtn.addEventListener("click", () => goToSynonymPage(state.synonymPage - 1));
  el.synonymNextPageBtn.addEventListener("click", () => goToSynonymPage(state.synonymPage + 1));
  el.swapLangBtn.addEventListener("click", swapSelectedLanguages);

  el.sourceText.addEventListener("input", handleTranslateInputsChanged);
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
  bindAsyncEvent(el.deckCutToolbarBtn, "click", cutSelectedDeckItems, "Could not cut deck items.");
  bindAsyncEvent(el.deckPasteToolbarBtn, "click", pasteDeckItems, "Could not paste deck items.");
  el.deckSearch.addEventListener("input", () => {
    state.deckPage = 1;
    renderDeck();
  });
  el.deckSort.addEventListener("change", () => {
    state.deckSort = el.deckSort.value;
    state.deckPage = 1;
    renderDeck();
  });
  el.deckPrevPageBtn.addEventListener("click", () => goToDeckPage(state.deckPage - 1));
  el.deckNextPageBtn.addEventListener("click", () => goToDeckPage(state.deckPage + 1));
  bindAsyncEvent(el.refreshDeckBtn, "click", refreshDeck, "Could not refresh deck.");
  bindAsyncEvent(el.importDeckBtn, "click", importDeckItems, "Could not import deck file.");
  bindAsyncEvent(el.exportDeckBtn, "click", exportDeckItems, "Could not export deck file.");

  bindAsyncEvent(el.saveApiKeyBtn, "click", saveGoogleApiKey, "Could not save API key.");
  bindAsyncEvent(el.clearApiKeyBtn, "click", clearGoogleApiKey, "Could not clear API key.");
  bindAsyncEvent(
    el.saveMicrosoftTranslatorBtn,
    "click",
    saveMicrosoftTranslatorSettings,
    "Could not save Microsoft Translator settings."
  );
  bindAsyncEvent(
    el.clearMicrosoftTranslatorBtn,
    "click",
    clearMicrosoftTranslatorSettings,
    "Could not clear Microsoft Translator settings."
  );

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

  bindAsyncEvent(el.useDefaultDbBtn, "click", async () => {
    try {
      await useDefaultDatabaseLocation();
      await refreshDatabaseLocationLabel();
      await refreshDeck();
      setStatus("Switched to default database location.");
    } catch (error) {
      setStatus(error?.message || "Failed to switch database.", true);
    }
  }, "Failed to switch database.");

  bindAsyncEvent(el.chooseDbBtn, "click", async () => {
    try {
      await chooseCustomDatabaseFile();
      await refreshDatabaseLocationLabel();
      await refreshDeck();
      setStatus("Custom database selected successfully.");
    } catch (error) {
      setStatus(error?.message || "Could not select custom database.", true);
    }
  }, "Could not select custom database.");

  bindAsyncEvent(el.highlightEnabled, "change", async () => {
    await saveHighlightSetting(el.highlightEnabled.checked);
    if (!popupContextAvailable) return;
    setStatus(`Highlight ${el.highlightEnabled.checked ? "enabled" : "disabled"}.`);
  }, "Could not update highlight setting.");

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

  bindAsyncEvent(el.applyHighlightToTabBtn, "click", applyHighlightToCurrentTab, "Could not apply highlight.");
}

async function init() {
  await initializeDatabase();
  renderLanguages();
  resetTranslateOutputs();
  el.deckSort.value = state.deckSort;
  bindEvents();
  updateDeckToolbarState();
  switchTab("translate");
  await Promise.all([
    refreshDeck(),
    refreshDatabaseLocationLabel(),
    loadHighlightSetting(),
    loadGoogleApiKey(),
    loadMicrosoftTranslatorSettings()
  ]);
  const loadedSelection = await fillTranslateFromActiveTabSelection();
  if (!loadedSelection) {
    setStatus("Ready.");
  }
  schedulePopupResize();
}

init().catch((error) => {
  handlePopupAsyncError(error, "Initialization failed.");
});

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE"]);
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);
const HIGHLIGHT_REFRESH_DELAY_MS = 80;
const HIGHLIGHT_USER_IDLE_DELAY_MS = 220;
const HIGHLIGHT_WALK_BATCH_SIZE = 250;
const HIGHLIGHT_APPLY_BATCH_SIZE = 150;
const SELECTION_SYNC_DELAY_MS = 120;
const SELECTION_ACTION_SETTLE_DELAY_MS = 24;
const INLINE_TRANSLATE_TARGET_LANG = "vi";
const INLINE_POPUP_TARGET_LINE_COUNT = 4;
const INLINE_POPUP_MIN_WIDTH = 188;
const INLINE_POPUP_MAX_WIDTH = 560;
const INLINE_POPUP_MIN_BOX_WIDTH = 68;
const SUPPORTED_HIGHLIGHT_PAGE_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const HIGHLIGHT_SELECTOR = "span.vocab-highlight";
const EXTENSION_UI_SELECTOR = ".vocab-selection-bubble, .vocab-inline-translate-popup, .vocab-highlight-tooltip, .vocab-inline-measure";
const EXTENSION_OWNED_SELECTOR = `${HIGHLIGHT_SELECTOR}, ${EXTENSION_UI_SELECTOR}`;

let lastSelectedText = "";
let tooltipElement = null;
let activeTooltipTarget = null;
let tooltipPositionFrame = 0;
let selectionBubbleElement = null;
let selectionPopupElement = null;
let selectionPopupSourceElement = null;
let selectionPopupMetaElement = null;
let selectionPopupResultElement = null;
let selectionPopupStatusElement = null;
let selectionPopupSaveButton = null;
let selectionUiAnchorRect = null;
let selectionUiPositionFrame = 0;
let selectionActionUpdateTimer = 0;
let highlightRefreshTimer = 0;
let selectionSyncTimer = 0;
let pendingSelectionText = "";
let activeHighlightRunId = 0;
let hasAppliedHighlights = false;
let selectionBubbleText = "";
let inlineTranslateRequestId = 0;
let inlineSaveRequestId = 0;
let highlightCache = createEmptyHighlightCache();
let inlinePopupState = createInlinePopupState();
let extensionContextAvailable = true;
const pageEventController = new AbortController();
let highlightEventController = null;
let inlinePopupMeasureElement = null;
let highlightMutationObserver = null;
let highlightMutationObserverPauseDepth = 0;
let highlightUserInteractionUntil = 0;
let highlightTextCompositionActive = false;
let pendingInteractionDeferredHighlight = false;
let pendingInteractionDeferredHighlightForce = false;
let incrementalHighlightRefreshTimer = 0;
let pendingIncrementalHighlightRoots = new Set();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHighlightTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeLookupKey(value) {
  return normalizeHighlightTerm(value).toLowerCase();
}

function buildHighlightPattern(value) {
  const normalizedValue = normalizeHighlightTerm(value);
  if (!normalizedValue) return "";

  const flexibleWhitespacePattern = normalizedValue.split(/\s+/).map(escapeRegExp).join("\\s+");

  if (normalizedValue.includes(" ")) {
    return flexibleWhitespacePattern;
  }

  return `(?<![\\p{L}\\p{N}_])${flexibleWhitespacePattern}(?![\\p{L}\\p{N}_])`;
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

function isHighlightBlockedOnCurrentPage(rules) {
  if (!Array.isArray(rules) || !rules.length) return false;

  const currentUrl = String(window.location.href || "").toLowerCase();
  const pageUrl = new URL(window.location.href);
  const currentHost = String(pageUrl.hostname || "").toLowerCase();
  const currentWithoutScheme = `${pageUrl.host}${pageUrl.pathname}${pageUrl.search}`.toLowerCase();

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

function getHighlightPageOverrideForCurrentPage(overrides) {
  const pageUrl = normalizeHighlightPageUrl(window.location.href);
  if (!pageUrl || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(overrides, pageUrl)) {
    return null;
  }

  return typeof overrides[pageUrl] === "boolean" ? overrides[pageUrl] : null;
}

function createEmptyHighlightCache(enabled = null) {
  return {
    enabled,
    deckRevision: -1,
    matchSignature: "",
    tooltipSignature: "",
    regex: null,
    termMeanings: new Map()
  };
}

function createInlinePopupState() {
  return {
    sourceText: "",
    translatedText: "",
    sourceLang: "auto",
    targetLang: INLINE_TRANSLATE_TARGET_LANG,
    loading: false,
    saving: false,
    saved: false,
    statusMessage: "",
    statusIsError: false
  };
}

function isExtensionContextInvalidatedError(error) {
  const message = error?.message || String(error || "");
  return message.includes("Extension context invalidated") || message.includes("context invalidated");
}

function hasLiveExtensionContext() {
  return extensionContextAvailable && !!globalThis.chrome?.runtime?.id;
}

function clearSelectionSync() {
  if (selectionSyncTimer) {
    clearTimeout(selectionSyncTimer);
    selectionSyncTimer = 0;
  }

  pendingSelectionText = "";
}

function removeInjectedElement(element) {
  if (element?.isConnected) {
    element.remove();
  }

  return null;
}

function removeInjectedUiElements() {
  cancelSelectionUiPosition();
  cancelTooltipPosition();
  clearSelectionActionUpdate();

  selectionBubbleElement = removeInjectedElement(selectionBubbleElement);
  selectionPopupElement = removeInjectedElement(selectionPopupElement);
  tooltipElement = removeInjectedElement(tooltipElement);
  inlinePopupMeasureElement = removeInjectedElement(inlinePopupMeasureElement);

  selectionPopupSourceElement = null;
  selectionPopupMetaElement = null;
  selectionPopupResultElement = null;
  selectionPopupStatusElement = null;
  selectionPopupSaveButton = null;
}

function removeStaleInjectedUiElements() {
  document.querySelectorAll(EXTENSION_UI_SELECTOR).forEach((node) => {
    node.remove();
  });
}

function ensureExtensionContext() {
  if (hasLiveExtensionContext()) return true;

  invalidateExtensionContext();
  return false;
}

function removeExtensionListeners() {
  try {
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  } catch {
    // Ignore stale context teardown failures.
  }
}

function invalidateExtensionContext() {
  if (!extensionContextAvailable) return;

  extensionContextAvailable = false;
  pageEventController.abort();
  stopHighlightRuntime();
  removeExtensionListeners();
  clearScheduledHighlightRun();
  highlightMutationObserverPauseDepth = 0;
  disconnectHighlightMutationObserver();
  highlightTextCompositionActive = false;
  pendingInteractionDeferredHighlight = false;
  pendingInteractionDeferredHighlightForce = false;
  clearScheduledIncrementalHighlightRun();
  pendingIncrementalHighlightRoots = new Set();
  clearSelectionSync();
  hideSelectionActionUi();
  hideTooltip();
  unwrapHighlights({ force: true });
  removeInjectedUiElements();
  highlightCache = createEmptyHighlightCache(false);
  lastSelectedText = "";
  selectionBubbleText = "";
  selectionUiAnchorRect = null;
  inlinePopupState = createInlinePopupState();
}

async function withExtensionContext(task, fallbackValue = null) {
  if (!hasLiveExtensionContext()) {
    invalidateExtensionContext();
    return fallbackValue;
  }

  try {
    return await task();
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      invalidateExtensionContext();
      return fallbackValue;
    }

    throw error;
  }
}

function getExtensionOwnedElement(node) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest(EXTENSION_OWNED_SELECTOR) || null;
}

function isExtensionOwnedNode(node) {
  return !!getExtensionOwnedElement(node);
}

function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) return false;

  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type);
  }

  if (element.isContentEditable) return true;

  const role = element.getAttribute("role");
  return role === "textbox" || role === "searchbox";
}

function getEditableContainer(node) {
  let element = node instanceof Element ? node : node?.parentElement;
  while (element) {
    if (isEditableElement(element)) {
      return element;
    }

    element = element.parentElement;
  }

  return null;
}

function isEditableNode(node) {
  return !!getEditableContainer(node);
}

function isExtensionUiNode(node) {
  const ownedElement = getExtensionOwnedElement(node);
  return !!ownedElement && !ownedElement.classList.contains("vocab-highlight");
}

function capturePageRect(rect) {
  return {
    top: rect.top + window.scrollY,
    right: rect.right + window.scrollX,
    bottom: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
    width: rect.width,
    height: rect.height
  };
}

function capturePagePoint(clientX, clientY) {
  return {
    top: clientY + window.scrollY,
    right: clientX + window.scrollX,
    bottom: clientY + window.scrollY,
    left: clientX + window.scrollX,
    width: 0,
    height: 0
  };
}

function getViewportRect(pageRect) {
  if (!pageRect) return null;

  return {
    top: pageRect.top - window.scrollY,
    right: pageRect.right - window.scrollX,
    bottom: pageRect.bottom - window.scrollY,
    left: pageRect.left - window.scrollX,
    width: pageRect.width,
    height: pageRect.height
  };
}

function getCurrentPageSelectionState() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const text = normalizeHighlightTerm(selection.toString());
  if (!text) return null;

  const range = selection.getRangeAt(0);
  if (isExtensionUiNode(range.commonAncestorContainer)) return null;

  let rect = range.getBoundingClientRect();
  if ((!rect.width && !rect.height) || Number.isNaN(rect.top)) {
    const fallbackRect = range.getClientRects()[0];
    if (!fallbackRect) return null;
    rect = fallbackRect;
  }

  return {
    text,
    anchorRect: capturePageRect(rect)
  };
}

function formatInlineLanguageLabel(languageCode) {
  const normalizedCode = String(languageCode || "auto").trim().toUpperCase();
  return normalizedCode || "AUTO";
}

function getSelectedTextFromActiveElement() {
  const activeElement = document.activeElement;
  if (!activeElement) return "";

  if (activeElement instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = activeElement;
    if (selectionStart === selectionEnd) return "";
    return value.slice(selectionStart, selectionEnd).trim();
  }

  if (activeElement instanceof HTMLInputElement) {
    if (!TEXT_INPUT_TYPES.has(activeElement.type)) return "";

    const { selectionStart, selectionEnd, value } = activeElement;
    if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return "";
    return value.slice(selectionStart, selectionEnd).trim();
  }

  return "";
}

function getCurrentSelectedText() {
  return getSelectedTextFromActiveElement() || window.getSelection?.()?.toString?.().trim?.() || "";
}

function markHighlightUserInteraction(durationMs = HIGHLIGHT_USER_IDLE_DELAY_MS) {
  highlightUserInteractionUntil = Date.now() + Math.max(durationMs, 0);
}

function hasActivePageSelection() {
  const selection = window.getSelection?.();
  return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
}

function shouldDeferHighlightForUserInteraction() {
  if (highlightTextCompositionActive) return true;
  if (Date.now() < highlightUserInteractionUntil) return true;
  if (hasActivePageSelection()) return true;
  return false;
}

function queueHighlightAfterInteraction(force = false) {
  pendingInteractionDeferredHighlight = true;
  pendingInteractionDeferredHighlightForce = pendingInteractionDeferredHighlightForce || force;
}

function flushQueuedHighlightAfterInteraction() {
  if (shouldDeferHighlightForUserInteraction()) return;

  if (pendingInteractionDeferredHighlight) {
    const force = pendingInteractionDeferredHighlightForce;
    pendingInteractionDeferredHighlight = false;
    pendingInteractionDeferredHighlightForce = false;
    clearScheduledIncrementalHighlightRun();
    pendingIncrementalHighlightRoots = new Set();
    scheduleHighlightRun({ force });
    return;
  }

  flushPendingIncrementalHighlightRun();
}

async function flushSelectionSync() {
  const selectedText = pendingSelectionText;
  clearSelectionSync();
  if (!ensureExtensionContext()) return;
  if (!selectedText) return;

  await withExtensionContext(() => chrome.runtime.sendMessage({ type: "selection-updated", selectedText }), null);
}

function scheduleSelectionSync(selectedText) {
  pendingSelectionText = selectedText;
  if (selectionSyncTimer) return;

  selectionSyncTimer = window.setTimeout(flushSelectionSync, SELECTION_SYNC_DELAY_MS);
}

function rememberCurrentSelection() {
  if (!ensureExtensionContext()) return;

  const selectedText = getCurrentSelectedText();
  if (!selectedText) {
    lastSelectedText = "";
    return;
  }
  if (selectedText === lastSelectedText) return;

  lastSelectedText = selectedText;
  scheduleSelectionSync(selectedText);
}

function addTooltipMeaning(termMeaningSets, term, meaning) {
  const termKey = normalizeLookupKey(term);
  const normalizedMeaning = normalizeHighlightTerm(meaning);
  if (!termKey || !normalizedMeaning) return;

  let meanings = termMeaningSets.get(termKey);
  if (!meanings) {
    meanings = new Set();
    termMeaningSets.set(termKey, meanings);
  }

  meanings.add(normalizedMeaning);
}

function buildHighlightModel(items) {
  const terms = new Set();
  const termMeaningSets = new Map();

  for (const item of items) {
    const source = normalizeHighlightTerm(item.sourceText);
    const translated = normalizeHighlightTerm(item.translatedText);

    if (source) {
      terms.add(source);
      addTooltipMeaning(termMeaningSets, source, translated);
    }
  }

  const sortedTerms = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const sortedMeaningEntries = [...termMeaningSets.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([termKey, meanings]) => [termKey, [...meanings].sort((left, right) => left.localeCompare(right))]);

  const pattern = sortedTerms.map(buildHighlightPattern).filter(Boolean).join("|");

  return {
    matchSignature: sortedTerms.join("\u0001"),
    tooltipSignature: sortedMeaningEntries
      .map(([termKey, meanings]) => `${termKey}\u0002${meanings.join("\u0003")}`)
      .join("\u0001"),
    regex: pattern ? new RegExp(`(${pattern})`, "giu") : null,
    termMeanings: new Map(sortedMeaningEntries)
  };
}

async function loadHighlightLexiconFromExtension(sinceRevision = null) {
  const message = { type: "get-highlight-lexicon" };
  if (Number.isInteger(sinceRevision)) {
    message.sinceRevision = sinceRevision;
  }

  const response = await withExtensionContext(() => chrome.runtime.sendMessage(message), null);
  if (!response?.ok) {
    return null;
  }

  return {
    revision: Number.isInteger(response.revision) ? response.revision : -1,
    entries: Array.isArray(response.entries) ? response.entries : null
  };
}

function ensureSelectionBubbleElement() {
  if (selectionBubbleElement?.isConnected) return selectionBubbleElement;

  selectionBubbleElement = document.createElement("button");
  selectionBubbleElement.type = "button";
  selectionBubbleElement.className = "vocab-selection-bubble";
  selectionBubbleElement.textContent = "";
  selectionBubbleElement.setAttribute("aria-label", "Translate selection");
  selectionBubbleElement.title = "Translate selection";
  selectionBubbleElement.hidden = true;
  selectionBubbleElement.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  selectionBubbleElement.addEventListener("click", () => {
    openInlineTranslatePopup().catch(() => {
      // Ignore inline translate popup failures to avoid breaking the host page.
    });
  });

  document.documentElement.appendChild(selectionBubbleElement);
  return selectionBubbleElement;
}

function ensureSelectionPopupElement() {
  if (selectionPopupElement?.isConnected) return selectionPopupElement;

  selectionPopupElement = document.createElement("div");
  selectionPopupElement.className = "vocab-inline-translate-popup";
  selectionPopupElement.hidden = true;
  selectionPopupElement.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });

  selectionPopupSourceElement = document.createElement("div");
  selectionPopupSourceElement.className = "vocab-inline-source";

  selectionPopupMetaElement = document.createElement("div");
  selectionPopupMetaElement.className = "vocab-inline-meta";

  selectionPopupResultElement = document.createElement("div");
  selectionPopupResultElement.className = "vocab-inline-result";

  selectionPopupStatusElement = document.createElement("div");
  selectionPopupStatusElement.className = "vocab-inline-status";
  selectionPopupStatusElement.hidden = true;

  selectionPopupSaveButton = document.createElement("button");
  selectionPopupSaveButton.type = "button";
  selectionPopupSaveButton.className = "vocab-inline-save";
  selectionPopupSaveButton.dataset.state = "idle";
  selectionPopupSaveButton.setAttribute("aria-label", "Save to Deck");
  selectionPopupSaveButton.title = "Save to Deck";
  selectionPopupSaveButton.disabled = true;
  selectionPopupSaveButton.addEventListener("click", () => {
    saveInlineTranslateResult().catch(() => {
      // Ignore save failures here and surface them in the popup state instead.
    });
  });

  const sourceRow = document.createElement("div");
  sourceRow.className = "vocab-inline-source-row";
  sourceRow.append(selectionPopupSourceElement, selectionPopupMetaElement);

  const content = document.createElement("div");
  content.className = "vocab-inline-content";
  content.append(selectionPopupResultElement, selectionPopupSaveButton);

  selectionPopupElement.append(
    sourceRow,
    content,
    selectionPopupStatusElement
  );

  document.documentElement.appendChild(selectionPopupElement);
  return selectionPopupElement;
}

function ensureInlinePopupMeasureElement() {
  if (inlinePopupMeasureElement?.isConnected) return inlinePopupMeasureElement;

  inlinePopupMeasureElement = document.createElement("div");
  inlinePopupMeasureElement.className = "vocab-inline-measure";
  inlinePopupMeasureElement.hidden = true;
  inlinePopupMeasureElement.setAttribute("aria-hidden", "true");
  inlinePopupMeasureElement.style.position = "fixed";
  inlinePopupMeasureElement.style.left = "-99999px";
  inlinePopupMeasureElement.style.top = "-99999px";
  inlinePopupMeasureElement.style.visibility = "hidden";
  inlinePopupMeasureElement.style.pointerEvents = "none";
  inlinePopupMeasureElement.style.maxHeight = "none";
  inlinePopupMeasureElement.style.minHeight = "0";
  inlinePopupMeasureElement.style.height = "auto";
  inlinePopupMeasureElement.style.overflow = "visible";
  inlinePopupMeasureElement.style.contain = "layout style";
  document.documentElement.appendChild(inlinePopupMeasureElement);
  return inlinePopupMeasureElement;
}

function countMeasuredLines(measureElement) {
  const computedStyle = getComputedStyle(measureElement);
  const lineHeight = getResolvedLineHeight(computedStyle);
  const paddingTop = parseFloat(computedStyle.paddingTop || "0");
  const paddingBottom = parseFloat(computedStyle.paddingBottom || "0");
  const contentHeight = Math.max(measureElement.scrollHeight - paddingTop - paddingBottom, 0);

  return Math.max(1, Math.ceil(contentHeight / lineHeight));
}

function countRenderedLines(element) {
  if (!element) return 1;

  const computedStyle = getComputedStyle(element);
  const lineHeight = getResolvedLineHeight(computedStyle);
  const paddingTop = parseFloat(computedStyle.paddingTop || "0");
  const paddingBottom = parseFloat(computedStyle.paddingBottom || "0");
  const contentHeight = Math.max(element.scrollHeight - paddingTop - paddingBottom, 0);

  return Math.max(1, Math.ceil(contentHeight / lineHeight));
}

function getResolvedLineHeight(computedStyle) {
  const numericLineHeight = parseFloat(computedStyle.lineHeight || "");
  if (Number.isFinite(numericLineHeight) && numericLineHeight > 0) {
    return numericLineHeight;
  }

  const fontSize = parseFloat(computedStyle.fontSize || "12");
  return (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12) * 1.45;
}

function measureInlinePopupParagraphWidth(referenceElement, text, minWidth, maxWidth) {
  if (!referenceElement) return minWidth;

  const rawText = String(text || "").trim();
  if (!rawText) return minWidth;

  const measureElement = ensureInlinePopupMeasureElement();
  measureElement.className = referenceElement.className;
  measureElement.textContent = rawText;
  measureElement.hidden = false;

  let low = Math.max(INLINE_POPUP_MIN_BOX_WIDTH, Math.floor(minWidth));
  let high = Math.max(low, Math.floor(maxWidth));
  let best = high;

  while (low <= high) {
    const width = Math.floor((low + high) / 2);
    measureElement.style.width = `${width}px`;

    const lineCount = countMeasuredLines(measureElement);
    if (lineCount <= INLINE_POPUP_TARGET_LINE_COUNT) {
      best = width;
      high = width - 1;
    } else {
      low = width + 1;
    }
  }

  measureElement.hidden = true;
  measureElement.textContent = "";
  return Math.min(Math.max(best, minWidth), maxWidth);
}

function updateInlinePopupWidth() {
  if (!selectionPopupElement || !selectionPopupSourceElement || !selectionPopupResultElement) return;

  const viewportMaxWidth = Math.max(INLINE_POPUP_MIN_WIDTH, window.innerWidth - 16);
  const popupMaxWidth = Math.min(INLINE_POPUP_MAX_WIDTH, viewportMaxWidth);
  const popupStyle = getComputedStyle(selectionPopupElement);
  const popupHorizontalChrome =
    parseFloat(popupStyle.paddingLeft || "0") +
    parseFloat(popupStyle.paddingRight || "0") +
    parseFloat(popupStyle.borderLeftWidth || "0") +
    parseFloat(popupStyle.borderRightWidth || "0");
  const sourceRowGap = parseFloat(getComputedStyle(selectionPopupSourceElement.parentElement).gap || "0");
  const contentRowGap = parseFloat(getComputedStyle(selectionPopupResultElement.parentElement).gap || "0");
  const metaWidth = selectionPopupMetaElement?.getBoundingClientRect().width || 0;
  const saveButtonWidth = selectionPopupSaveButton?.getBoundingClientRect().width || 0;
  const sourceBoxMaxWidth = Math.max(
    INLINE_POPUP_MIN_BOX_WIDTH,
    popupMaxWidth - popupHorizontalChrome - metaWidth - sourceRowGap
  );
  const resultBoxMaxWidth = Math.max(
    INLINE_POPUP_MIN_BOX_WIDTH,
    popupMaxWidth - popupHorizontalChrome - saveButtonWidth - contentRowGap
  );
  const sourceText = inlinePopupState.sourceText || " ";
  const resultText = inlinePopupState.loading
    ? "Translating..."
    : inlinePopupState.translatedText || inlinePopupState.statusMessage || "Translation unavailable.";
  const sourceBoxWidth = measureInlinePopupParagraphWidth(
    selectionPopupSourceElement,
    sourceText,
    INLINE_POPUP_MIN_BOX_WIDTH,
    sourceBoxMaxWidth
  );
  const resultBoxWidth = measureInlinePopupParagraphWidth(
    selectionPopupResultElement,
    resultText,
    INLINE_POPUP_MIN_BOX_WIDTH,
    resultBoxMaxWidth
  );
  const sourceRowWidth = sourceBoxWidth + metaWidth + sourceRowGap;
  const contentRowWidth = resultBoxWidth + saveButtonWidth + contentRowGap;
  const popupWidth = Math.min(
    Math.max(Math.ceil(Math.max(sourceRowWidth, contentRowWidth) + popupHorizontalChrome), INLINE_POPUP_MIN_WIDTH),
    popupMaxWidth
  );

  let resolvedPopupWidth = popupWidth;
  selectionPopupElement.style.setProperty("--vocab-inline-popup-width", `${resolvedPopupWidth}px`);
  selectionPopupElement.style.setProperty("width", `${resolvedPopupWidth}px`, "important");
  selectionPopupElement.style.setProperty("min-width", `${resolvedPopupWidth}px`, "important");
  selectionPopupElement.style.setProperty("max-width", `${resolvedPopupWidth}px`, "important");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sourceLines = countRenderedLines(selectionPopupSourceElement);
    const resultLines = countRenderedLines(selectionPopupResultElement);
    const maxLines = Math.max(sourceLines, resultLines);

    if (maxLines <= INLINE_POPUP_TARGET_LINE_COUNT || resolvedPopupWidth >= popupMaxWidth) {
      break;
    }

    const extraWidth = Math.max(28, (maxLines - INLINE_POPUP_TARGET_LINE_COUNT) * 36);
    resolvedPopupWidth = Math.min(resolvedPopupWidth + extraWidth, popupMaxWidth);
    selectionPopupElement.style.setProperty("--vocab-inline-popup-width", `${resolvedPopupWidth}px`);
    selectionPopupElement.style.setProperty("width", `${resolvedPopupWidth}px`, "important");
    selectionPopupElement.style.setProperty("min-width", `${resolvedPopupWidth}px`, "important");
    selectionPopupElement.style.setProperty("max-width", `${resolvedPopupWidth}px`, "important");
  }
}

function isSelectionBubbleVisible() {
  return !!selectionBubbleElement && !selectionBubbleElement.hidden;
}
//
function isInlineTranslatePopupVisible() {
  return !!selectionPopupElement && !selectionPopupElement.hidden;
}

function ensureTooltipElement() {
  if (tooltipElement?.isConnected) return tooltipElement;

  tooltipElement = document.createElement("div");
  tooltipElement.className = "vocab-highlight-tooltip";
  tooltipElement.hidden = true;
  document.documentElement.appendChild(tooltipElement);
  return tooltipElement;
}

function cancelSelectionUiPosition() {
  if (selectionUiPositionFrame) {
    cancelAnimationFrame(selectionUiPositionFrame);
    selectionUiPositionFrame = 0;
  }
}

function clearSelectionActionUpdate() {
  if (selectionActionUpdateTimer) {
    clearTimeout(selectionActionUpdateTimer);
    selectionActionUpdateTimer = 0;
  }
}

function positionFloatingElement(element, pageRect, spacing = 10, preferredPlacement = "above") {
  if (!element || element.hidden || !pageRect) return;

  const viewportRect = getViewportRect(pageRect);
  if (!viewportRect) return;

  const viewportPadding = 8;
  const elementRect = element.getBoundingClientRect();
  const preferredTop =
    preferredPlacement === "below"
      ? viewportRect.bottom + spacing
      : viewportRect.top - elementRect.height - spacing;
  const fallbackTop =
    preferredPlacement === "below"
      ? viewportRect.top - elementRect.height - spacing
      : viewportRect.bottom + spacing;

  let top = preferredTop;
  if (top < viewportPadding || top + elementRect.height > window.innerHeight - viewportPadding) {
    top = fallbackTop;
  }

  let left = viewportRect.left + (viewportRect.width - elementRect.width) / 2;
  left = Math.min(left, window.innerWidth - elementRect.width - viewportPadding);
  left = Math.max(left, viewportPadding);

  element.style.top = `${Math.max(top, viewportPadding)}px`;
  element.style.left = `${left}px`;
}

function renderInlineTranslatePopup() {
  if (!selectionPopupElement) return;

  selectionPopupSourceElement.textContent = inlinePopupState.sourceText;
  selectionPopupMetaElement.textContent = `${formatInlineLanguageLabel(
    inlinePopupState.sourceLang
  )} -> ${formatInlineLanguageLabel(inlinePopupState.targetLang)}`;

  if (inlinePopupState.loading) {
    selectionPopupResultElement.textContent = "Translating...";
    selectionPopupResultElement.classList.remove("is-error");
  } else if (inlinePopupState.translatedText) {
    selectionPopupResultElement.textContent = inlinePopupState.translatedText;
    selectionPopupResultElement.classList.remove("is-error");
  } else {
    selectionPopupResultElement.textContent = "Translation unavailable.";
    selectionPopupResultElement.classList.toggle("is-error", inlinePopupState.statusIsError);
  }

  selectionPopupStatusElement.textContent = inlinePopupState.statusMessage;
  selectionPopupStatusElement.hidden = !inlinePopupState.statusMessage;
  selectionPopupStatusElement.classList.toggle("is-error", inlinePopupState.statusIsError);

  selectionPopupSaveButton.disabled =
    inlinePopupState.loading ||
    inlinePopupState.saving ||
    !inlinePopupState.translatedText ||
    inlinePopupState.saved;
  selectionPopupSaveButton.dataset.state = inlinePopupState.saving
    ? "saving"
    : inlinePopupState.saved
      ? "saved"
      : "idle";
  selectionPopupSaveButton.setAttribute(
    "aria-label",
    inlinePopupState.saving
      ? "Saving to Deck"
      : inlinePopupState.saved
        ? "Saved to Deck"
        : "Save to Deck"
  );
  selectionPopupSaveButton.title = selectionPopupSaveButton.getAttribute("aria-label");
  updateInlinePopupWidth();
}

function scheduleSelectionUiPosition() {
  if ((!isSelectionBubbleVisible() && !isInlineTranslatePopupVisible()) || selectionUiPositionFrame) return;

  selectionUiPositionFrame = requestAnimationFrame(() => {
    selectionUiPositionFrame = 0;

    if (isSelectionBubbleVisible()) {
      positionFloatingElement(selectionBubbleElement, selectionUiAnchorRect, 22, "below");
    }

    if (isInlineTranslatePopupVisible()) {
      updateInlinePopupWidth();
      positionFloatingElement(selectionPopupElement, selectionUiAnchorRect, 12);
    }
  });
}

function hideSelectionBubble() {
  clearSelectionActionUpdate();
  cancelSelectionUiPosition();

  if (selectionBubbleElement) {
    selectionBubbleElement.hidden = true;
  }
}

function hideInlineTranslatePopup() {
  clearSelectionActionUpdate();
  cancelSelectionUiPosition();
  inlineTranslateRequestId += 1;
  inlineSaveRequestId += 1;
  inlinePopupState = createInlinePopupState();

  if (selectionPopupElement) {
    selectionPopupElement.hidden = true;
    selectionPopupElement.style.removeProperty("--vocab-inline-popup-width");
    selectionPopupElement.style.removeProperty("width");
    selectionPopupElement.style.removeProperty("min-width");
    selectionPopupElement.style.removeProperty("max-width");
  }
}

function hideSelectionActionUi() {
  clearSelectionActionUpdate();
  hideSelectionBubble();
  hideInlineTranslatePopup();
  selectionBubbleText = "";
  selectionUiAnchorRect = null;
}

function showSelectionBubble(text, anchorRect) {
  if (!text || !anchorRect) return;

  hideTooltip();
  selectionBubbleText = text;
  selectionUiAnchorRect = anchorRect;
  ensureSelectionBubbleElement().hidden = false;
  if (selectionPopupElement) {
    selectionPopupElement.hidden = true;
  }
  scheduleSelectionUiPosition();
}

async function openInlineTranslatePopup() {
  if (!ensureExtensionContext()) return;
  if (!selectionBubbleText || !selectionUiAnchorRect) return;

  hideTooltip();
  hideSelectionBubble();
  ensureSelectionPopupElement().hidden = false;
  selectionPopupElement.style.removeProperty("--vocab-inline-popup-width");
  selectionPopupElement.style.removeProperty("width");
  selectionPopupElement.style.removeProperty("min-width");
  selectionPopupElement.style.removeProperty("max-width");

  inlinePopupState = {
    sourceText: selectionBubbleText,
    translatedText: "",
    sourceLang: "auto",
    targetLang: INLINE_TRANSLATE_TARGET_LANG,
    loading: true,
    saving: false,
    saved: false,
    statusMessage: "",
    statusIsError: false
  };
  renderInlineTranslatePopup();
  scheduleSelectionUiPosition();

  const requestId = ++inlineTranslateRequestId;

  try {
    const response = await withExtensionContext(
      () =>
        chrome.runtime.sendMessage({
          type: "translate-inline-selection",
          text: selectionBubbleText,
          source: "auto",
          target: INLINE_TRANSLATE_TARGET_LANG
        }),
      null
    );

    if (requestId !== inlineTranslateRequestId || !response) return;

    if (!response?.ok) {
      throw new Error(response?.error || "Translation failed.");
    }

    const translatedText = String(response.translatedText || "").trim();
    inlinePopupState = {
      ...inlinePopupState,
      translatedText,
      sourceLang: response.detectedSourceLanguage || "auto",
      loading: false,
      statusMessage: translatedText ? "" : "No translation returned.",
      statusIsError: !translatedText
    };
    renderInlineTranslatePopup();
  } catch (error) {
    if (requestId !== inlineTranslateRequestId) return;

    inlinePopupState = {
      ...inlinePopupState,
      loading: false,
      statusMessage: error?.message || "Translation failed.",
      statusIsError: true
    };
    renderInlineTranslatePopup();
  }
}

async function saveInlineTranslateResult() {
  if (!ensureExtensionContext()) return;
  if (
    !inlinePopupState.sourceText ||
    !inlinePopupState.translatedText ||
    inlinePopupState.loading ||
    inlinePopupState.saving ||
    inlinePopupState.saved
  ) {
    return;
  }

  inlinePopupState = {
    ...inlinePopupState,
    saving: true,
    statusMessage: "",
    statusIsError: false
  };
  renderInlineTranslatePopup();

  const requestId = ++inlineSaveRequestId;

  try {
    const response = await withExtensionContext(
      () =>
        chrome.runtime.sendMessage({
          type: "save-inline-deck-item",
          sourceText: inlinePopupState.sourceText,
          translatedText: inlinePopupState.translatedText,
          sourceLang: inlinePopupState.sourceLang,
          targetLang: inlinePopupState.targetLang
        }),
      null
    );

    if (requestId !== inlineSaveRequestId || !response) return;

    if (!response?.ok) {
      throw new Error(response?.error || "Could not save deck item.");
    }

    inlinePopupState = {
      ...inlinePopupState,
      saving: false,
      saved: true,
      statusMessage: "Saved to Deck.",
      statusIsError: false
    };
    renderInlineTranslatePopup();
  } catch (error) {
    if (requestId !== inlineSaveRequestId) return;

    inlinePopupState = {
      ...inlinePopupState,
      saving: false,
      statusMessage: error?.message || "Could not save deck item.",
      statusIsError: true
    };
    renderInlineTranslatePopup();
  }
}

function cancelTooltipPosition() {
  if (tooltipPositionFrame) {
    cancelAnimationFrame(tooltipPositionFrame);
    tooltipPositionFrame = 0;
  }
}

function hideTooltip() {
  cancelTooltipPosition();

  if (tooltipElement) {
    tooltipElement.hidden = true;
  }

  activeTooltipTarget = null;
}

function hasActiveHighlightRuntime() {
  return !!highlightEventController && !highlightEventController.signal.aborted;
}

function stopHighlightRuntime() {
  if (hasActiveHighlightRuntime()) {
    highlightEventController.abort();
  }
  highlightEventController = null;

  clearScheduledHighlightRun();
  clearScheduledIncrementalHighlightRun();
  pendingIncrementalHighlightRoots = new Set();
  pendingInteractionDeferredHighlight = false;
  pendingInteractionDeferredHighlightForce = false;
  highlightTextCompositionActive = false;
  highlightUserInteractionUntil = 0;
  activeHighlightRunId += 1;
  disconnectHighlightMutationObserver();
  hideTooltip();
}

function startHighlightRuntime() {
  if (hasActiveHighlightRuntime()) return;

  highlightEventController = new AbortController();
  bindTooltipEvents(highlightEventController.signal);
  bindHighlightInteractionEvents(highlightEventController.signal);
}

function positionTooltip(target) {
  if (!tooltipElement || tooltipElement.hidden) return;
  if (!target?.isConnected) {
    hideTooltip();
    return;
  }

  const viewportPadding = 8;
  const spacing = 10;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltipElement.getBoundingClientRect();

  let top = targetRect.top - tooltipRect.height - spacing;
  if (top < viewportPadding) {
    top = targetRect.bottom + spacing;
  }

  let left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
  left = Math.min(left, window.innerWidth - tooltipRect.width - viewportPadding);
  left = Math.max(left, viewportPadding);

  tooltipElement.style.top = `${Math.max(top, viewportPadding)}px`;
  tooltipElement.style.left = `${left}px`;
}

function scheduleTooltipPosition() {
  if (!activeTooltipTarget || tooltipPositionFrame) return;

  tooltipPositionFrame = requestAnimationFrame(() => {
    tooltipPositionFrame = 0;
    if (activeTooltipTarget) {
      positionTooltip(activeTooltipTarget);
    }
  });
}

function getTooltipText(target) {
  const tooltipKey = target.dataset.vocabKey?.trim() || "";
  if (!tooltipKey) return "";

  return highlightCache.termMeanings.get(tooltipKey)?.join("\n") || "";
}

function showTooltip(target) {
  if (!(target instanceof HTMLElement)) return;

  const tooltipText = getTooltipText(target);
  if (!tooltipText) {
    hideTooltip();
    return;
  }

  const tooltip = ensureTooltipElement();
  tooltip.textContent = tooltipText;
  tooltip.hidden = false;
  activeTooltipTarget = target;
  scheduleTooltipPosition();
}

function updateSelectionActionFromCurrentSelection(anchorRectOverride = null) {
  if (!ensureExtensionContext()) return;

  const selectionState = getCurrentPageSelectionState();

  if (!selectionState) {
    hideSelectionBubble();
    if (!isInlineTranslatePopupVisible()) {
      selectionBubbleText = "";
      selectionUiAnchorRect = null;
    }
    return;
  }

  const anchorRect = anchorRectOverride || selectionState.anchorRect;
  selectionBubbleText = selectionState.text;
  selectionUiAnchorRect = anchorRect;

  if (isInlineTranslatePopupVisible()) {
    if (inlinePopupState.sourceText !== selectionState.text) {
      hideInlineTranslatePopup();
      showSelectionBubble(selectionState.text, anchorRect);
      return;
    }

    scheduleSelectionUiPosition();
    return;
  }

  showSelectionBubble(selectionState.text, anchorRect);
}

function handleSelectionActionSelectionChange() {
  if (!ensureExtensionContext()) return;

  const selectionState = getCurrentPageSelectionState();

  if (!selectionState) {
    if (!isInlineTranslatePopupVisible()) {
      hideSelectionBubble();
      selectionBubbleText = "";
      selectionUiAnchorRect = null;
    }
    return;
  }

  selectionBubbleText = selectionState.text;
  selectionUiAnchorRect = selectionState.anchorRect;

  if (isInlineTranslatePopupVisible()) {
    if (inlinePopupState.sourceText !== selectionState.text) {
      hideInlineTranslatePopup();
      return;
    }

    scheduleSelectionUiPosition();
    return;
  }

  hideSelectionBubble();
}

function clearPageSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return;

  selection.removeAllRanges();
}

function queueSelectionActionUpdate(anchorRectOverride = null) {
  clearSelectionActionUpdate();
  selectionActionUpdateTimer = window.setTimeout(() => {
    selectionActionUpdateTimer = 0;
    updateSelectionActionFromCurrentSelection(anchorRectOverride);
  }, SELECTION_ACTION_SETTLE_DELAY_MS);
}

function bindSelectionActionEvents() {
  const listenerOptions = { signal: pageEventController.signal };

  document.addEventListener("selectionchange", handleSelectionActionSelectionChange, listenerOptions);
  document.addEventListener("mouseup", (event) => {
    if (!ensureExtensionContext()) return;

    const target = event.target;
    if (isExtensionUiNode(target)) return;
    queueSelectionActionUpdate(capturePagePoint(event.clientX, event.clientY));
  }, listenerOptions);
  document.addEventListener("keyup", () => {
    if (!ensureExtensionContext()) return;

    queueSelectionActionUpdate();
  }, listenerOptions);

  document.addEventListener(
    "mousedown",
    (event) => {
      if (!ensureExtensionContext()) return;

      const target = event.target;
      if (isExtensionUiNode(target)) return;

      if (isSelectionBubbleVisible() || isInlineTranslatePopupVisible()) {
        clearPageSelection();
        hideSelectionActionUi();
      }
    },
    { capture: true, signal: pageEventController.signal }
  );

  document.addEventListener("keydown", (event) => {
    if (!ensureExtensionContext()) return;

    if (event.key === "Escape") {
      hideSelectionActionUi();
    }
  }, listenerOptions);
}

function bindSharedUiEvents() {
  const listenerOptions = { signal: pageEventController.signal };

  window.addEventListener("resize", () => {
    if (!ensureExtensionContext()) return;

    if (activeTooltipTarget) {
      scheduleTooltipPosition();
    }

    if (isSelectionBubbleVisible() || isInlineTranslatePopupVisible()) {
      scheduleSelectionUiPosition();
    }
  }, listenerOptions);

  document.addEventListener(
    "scroll",
    () => {
      if (!ensureExtensionContext()) return;

      if (activeTooltipTarget) {
        scheduleTooltipPosition();
      }

      if (isSelectionBubbleVisible() || isInlineTranslatePopupVisible()) {
        scheduleSelectionUiPosition();
      }
    },
    { capture: true, signal: pageEventController.signal }
  );
}

function bindTooltipEvents(signal) {
  const listenerOptions = { signal };

  document.addEventListener("mouseover", (event) => {
    if (!ensureExtensionContext()) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const highlight = target.closest(".vocab-highlight");
    if (!highlight) return;

    showTooltip(highlight);
  }, listenerOptions);

  document.addEventListener("mouseout", (event) => {
    if (!ensureExtensionContext()) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const highlight = target.closest(".vocab-highlight");
    if (!highlight) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof HTMLElement && relatedTarget.closest(".vocab-highlight") === highlight) {
      return;
    }

    hideTooltip();
  }, listenerOptions);
}

function bindHighlightInteractionEvents(signal) {
  const listenerOptions = { signal };

  const markIfEditableInteraction = (event) => {
    if (!ensureExtensionContext()) return;

    const target = event.target instanceof Node ? event.target : document.activeElement;
    if (!isEditableNode(target)) return;

    markHighlightUserInteraction();
  };

  document.addEventListener("selectionchange", () => {
    if (!ensureExtensionContext()) return;
    if (hasActivePageSelection()) return;

    flushQueuedHighlightAfterInteraction();
  }, listenerOptions);
  document.addEventListener("keydown", markIfEditableInteraction, listenerOptions);
  document.addEventListener("beforeinput", markIfEditableInteraction, listenerOptions);
  document.addEventListener("input", markIfEditableInteraction, listenerOptions);
  document.addEventListener("compositionstart", (event) => {
    if (!ensureExtensionContext()) return;
    if (!isEditableNode(event.target instanceof Node ? event.target : document.activeElement)) return;

    highlightTextCompositionActive = true;
    markHighlightUserInteraction();
  }, listenerOptions);
  document.addEventListener("compositionend", (event) => {
    if (!ensureExtensionContext()) return;
    if (!isEditableNode(event.target instanceof Node ? event.target : document.activeElement)) return;

    highlightTextCompositionActive = false;
    markHighlightUserInteraction();
    queueHighlightAfterInteraction(true);
    scheduleHighlightRun({ force: true });
  }, listenerOptions);
}

function getHighlightNodesWithin(root) {
  if (root instanceof Document) {
    return [...root.querySelectorAll(HIGHLIGHT_SELECTOR)];
  }
  if (!(root instanceof Element)) {
    return [];
  }

  const highlightNodes = [];
  if (root.matches(HIGHLIGHT_SELECTOR)) {
    highlightNodes.push(root);
  }

  highlightNodes.push(...root.querySelectorAll(HIGHLIGHT_SELECTOR));
  return highlightNodes;
}

function replaceHighlightNodesWithText(highlightNodes) {
  const parentNodes = new Set();

  highlightNodes.forEach((node) => {
    const parentNode = node.parentNode;
    if (!parentNode) return;

    parentNodes.add(parentNode);
    const text = document.createTextNode(node.textContent || "");
    node.replaceWith(text);
  });

  parentNodes.forEach((parentNode) => {
    parentNode.normalize?.();
  });
}

function hasHighlightNodes() {
  return !!document.querySelector(HIGHLIGHT_SELECTOR);
}

function unwrapHighlights(options = {}) {
  const { force = false } = options;
  hideTooltip();

  const nodes = getHighlightNodesWithin(document);
  if (!nodes.length) {
    hasAppliedHighlights = false;
    return;
  }

  if (!force && !hasAppliedHighlights) {
    hasAppliedHighlights = true;
  }

  replaceHighlightNodesWithText(nodes);

  hasAppliedHighlights = false;
}

function unwrapHighlightsWithin(root) {
  const highlightNodes = getHighlightNodesWithin(root);
  if (!highlightNodes.length) return;

  hideTooltip();
  replaceHighlightNodesWithText(highlightNodes);
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function hasRelevantHighlightMutation(records) {
  return records.some((record) => {
    if (record.type === "characterData") {
      return !isExtensionOwnedNode(record.target) && !isEditableNode(record.target);
    }

    if (record.type !== "childList") {
      return false;
    }

    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    return changedNodes.some((node) => !isExtensionOwnedNode(node) && !isEditableNode(node));
  });
}

function getIncrementalHighlightRoot(node) {
  let root = node instanceof Element ? node : node?.parentElement;
  if (!root) return null;
  if (root === document.documentElement) {
    root = document.body;
  }
  if (!root || !document.body?.contains(root)) return null;
  if (isExtensionOwnedNode(root) || isEditableNode(root)) return null;

  return root;
}

function normalizeIncrementalHighlightRoots(roots) {
  const normalizedRoots = [];

  for (const candidate of roots) {
    const root = getIncrementalHighlightRoot(candidate);
    if (!root) continue;

    if (normalizedRoots.some((existingRoot) => existingRoot === root || existingRoot.contains(root))) {
      continue;
    }

    for (let index = normalizedRoots.length - 1; index >= 0; index -= 1) {
      const existingRoot = normalizedRoots[index];
      if (root.contains(existingRoot)) {
        normalizedRoots.splice(index, 1);
      }
    }

    normalizedRoots.push(root);
  }

  return normalizedRoots;
}

function queueIncrementalHighlightRoots(roots) {
  for (const root of normalizeIncrementalHighlightRoots(roots)) {
    pendingIncrementalHighlightRoots.add(root);
  }
}

function consumePendingIncrementalHighlightRoots() {
  const roots = normalizeIncrementalHighlightRoots([...pendingIncrementalHighlightRoots]);
  pendingIncrementalHighlightRoots = new Set();
  return roots;
}

function collectIncrementalHighlightRoots(records) {
  const roots = [];

  for (const record of records) {
    if (record.type === "characterData") {
      roots.push(record.target);
      continue;
    }

    if (record.type !== "childList") {
      continue;
    }

    roots.push(record.target);

    for (const node of record.addedNodes) {
      roots.push(node);
    }
  }

  return normalizeIncrementalHighlightRoots(roots);
}

function ensureHighlightMutationObserver() {
  if (highlightMutationObserver) return highlightMutationObserver;

  highlightMutationObserver = new MutationObserver((records) => {
    if (!ensureExtensionContext()) return;
    if (activeTooltipTarget && !activeTooltipTarget.isConnected) {
      hideTooltip();
    }
    if (highlightCache.enabled === false || !highlightCache.regex) return;
    if (!hasRelevantHighlightMutation(records)) return;

    scheduleIncrementalHighlightRun(collectIncrementalHighlightRoots(records));
  });

  return highlightMutationObserver;
}

function disconnectHighlightMutationObserver() {
  highlightMutationObserver?.disconnect();
}

function shouldObserveHighlightMutations() {
  return hasLiveExtensionContext() && highlightCache.enabled === true && !!highlightCache.regex;
}

function connectHighlightMutationObserver() {
  if (!document.body || highlightMutationObserverPauseDepth > 0 || !shouldObserveHighlightMutations()) {
    disconnectHighlightMutationObserver();
    return;
  }

  const observer = ensureHighlightMutationObserver();
  observer.disconnect();
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function suspendHighlightMutationObserver() {
  highlightMutationObserverPauseDepth += 1;
  if (highlightMutationObserverPauseDepth === 1) {
    disconnectHighlightMutationObserver();
  }
}

function resumeHighlightMutationObserver() {
  if (highlightMutationObserverPauseDepth === 0) return;

  highlightMutationObserverPauseDepth -= 1;
  if (highlightMutationObserverPauseDepth === 0 && shouldObserveHighlightMutations()) {
    connectHighlightMutationObserver();
  }
}

async function collectMatchingTextNodesWithin(root, regex, runId) {
  if (!(root instanceof Element) || !document.body?.contains(root)) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let scannedNodes = 0;

  while (walker.nextNode()) {
    if (runId !== activeHighlightRunId) return null;
    scannedNodes += 1;

    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (SKIP_TAGS.has(parent.tagName)) continue;
    if (parent.classList?.contains("vocab-highlight")) continue;
    if (isEditableNode(node)) continue;

    const nodeValue = node.nodeValue || "";
    regex.lastIndex = 0;
    if (!nodeValue || !regex.test(nodeValue)) continue;

    regex.lastIndex = 0;
    textNodes.push(node);

    if (scannedNodes % HIGHLIGHT_WALK_BATCH_SIZE === 0) {
      await yieldToBrowser();
    }
  }

  return textNodes;
}

async function collectMatchingTextNodes(regex, runId) {
  if (!document.body) return [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let scannedNodes = 0;

  while (walker.nextNode()) {
    if (runId !== activeHighlightRunId) return null;
    scannedNodes += 1;

    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (SKIP_TAGS.has(parent.tagName)) continue;
    if (parent.classList?.contains("vocab-highlight")) continue;
    if (isEditableNode(node)) continue;

    const nodeValue = node.nodeValue || "";
    regex.lastIndex = 0;
    if (!nodeValue || !regex.test(nodeValue)) continue;

    regex.lastIndex = 0;
    textNodes.push(node);

    if (scannedNodes % HIGHLIGHT_WALK_BATCH_SIZE === 0) {
      await yieldToBrowser();
    }
  }

  return textNodes;
}

async function runIncrementalHighlight(roots) {
  if (!ensureExtensionContext()) return false;
  if (shouldDeferHighlightForUserInteraction()) {
    scheduleIncrementalHighlightRun(roots);
    return false;
  }
  if (highlightCache.enabled !== true || !highlightCache.regex) {
    return false;
  }

  const normalizedRoots = normalizeIncrementalHighlightRoots(roots);
  if (!normalizedRoots.length) return false;

  suspendHighlightMutationObserver();

  try {
    const runId = ++activeHighlightRunId;
    let appliedAnyHighlights = false;

    for (const root of normalizedRoots) {
      if (runId !== activeHighlightRunId) return false;
      if (!document.body?.contains(root)) continue;

      unwrapHighlightsWithin(root);

      const textNodes = await collectMatchingTextNodesWithin(root, highlightCache.regex, runId);
      if (!textNodes || runId !== activeHighlightRunId) return false;

      const appliedHighlights = await applyHighlightsToTextNodes(textNodes, highlightCache.regex, runId);
      if (runId !== activeHighlightRunId) return false;

      appliedAnyHighlights = appliedAnyHighlights || appliedHighlights;
    }

    hasAppliedHighlights = hasHighlightNodes();
    return appliedAnyHighlights;
  } finally {
    resumeHighlightMutationObserver();
  }
}

async function applyHighlightsToTextNodes(textNodes, regex, runId) {
  let appliedCount = 0;

  for (let index = 0; index < textNodes.length; index += 1) {
    if (runId !== activeHighlightRunId) return false;

    const node = textNodes[index];
    const text = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    regex.lastIndex = 0;
    text.replace(regex, (match, _p1, offset) => {
      if (offset > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
      }

      const span = document.createElement("span");
      span.className = "vocab-highlight";
      span.textContent = match;

      const tooltipKey = normalizeLookupKey(match);
      if (highlightCache.termMeanings.has(tooltipKey)) {
        span.dataset.vocabKey = tooltipKey;
      }

      fragment.appendChild(span);
      lastIndex = offset + match.length;
      appliedCount += 1;
      return match;
    });

    if (lastIndex === 0) continue;

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.replaceWith(fragment);

    if ((index + 1) % HIGHLIGHT_APPLY_BATCH_SIZE === 0) {
      await yieldToBrowser();
    }
  }

  return appliedCount > 0;
}

function clearScheduledHighlightRun() {
  if (highlightRefreshTimer) {
    clearTimeout(highlightRefreshTimer);
    highlightRefreshTimer = 0;
  }
}

function clearScheduledIncrementalHighlightRun() {
  if (incrementalHighlightRefreshTimer) {
    clearTimeout(incrementalHighlightRefreshTimer);
    incrementalHighlightRefreshTimer = 0;
  }
}

function flushPendingIncrementalHighlightRun() {
  if (pendingInteractionDeferredHighlight) {
    pendingIncrementalHighlightRoots = new Set();
    return;
  }

  if (shouldDeferHighlightForUserInteraction()) {
    if (pendingIncrementalHighlightRoots.size && !hasActivePageSelection()) {
      clearScheduledIncrementalHighlightRun();
      incrementalHighlightRefreshTimer = window.setTimeout(() => {
        incrementalHighlightRefreshTimer = 0;
        flushQueuedHighlightAfterInteraction();
      }, HIGHLIGHT_USER_IDLE_DELAY_MS);
    }
    return;
  }

  const roots = consumePendingIncrementalHighlightRoots();
  if (!roots.length) return;

  runIncrementalHighlight(roots).catch(() => {
    // Ignore incremental highlight refresh failures to avoid breaking the host page.
  });
}

function scheduleIncrementalHighlightRun(roots = []) {
  queueIncrementalHighlightRoots(roots);
  if (!pendingIncrementalHighlightRoots.size) return;
  if (pendingInteractionDeferredHighlight) return;

  clearScheduledIncrementalHighlightRun();

  if (shouldDeferHighlightForUserInteraction()) {
    if (!hasActivePageSelection()) {
      incrementalHighlightRefreshTimer = window.setTimeout(() => {
        incrementalHighlightRefreshTimer = 0;
        flushQueuedHighlightAfterInteraction();
      }, HIGHLIGHT_USER_IDLE_DELAY_MS);
    }
    return;
  }

  incrementalHighlightRefreshTimer = window.setTimeout(() => {
    incrementalHighlightRefreshTimer = 0;
    flushPendingIncrementalHighlightRun();
  }, HIGHLIGHT_REFRESH_DELAY_MS);
}

function scheduleHighlightRun(options = {}) {
  const { force = false } = options;
  clearScheduledIncrementalHighlightRun();
  pendingIncrementalHighlightRoots = new Set();

  if (shouldDeferHighlightForUserInteraction()) {
    queueHighlightAfterInteraction(force);
    clearScheduledHighlightRun();

    if (!hasActivePageSelection()) {
      highlightRefreshTimer = window.setTimeout(() => {
        highlightRefreshTimer = 0;
        flushQueuedHighlightAfterInteraction();
      }, HIGHLIGHT_USER_IDLE_DELAY_MS);
    }
    return;
  }

  clearScheduledHighlightRun();
  highlightRefreshTimer = window.setTimeout(() => {
    highlightRefreshTimer = 0;
    pendingInteractionDeferredHighlight = false;
    pendingInteractionDeferredHighlightForce = false;

    runHighlight({ force }).catch(() => {
      // Ignore highlight refresh failures to avoid breaking the host page.
    });
  }, HIGHLIGHT_REFRESH_DELAY_MS);
}

async function runHighlight(options = {}) {
  if (!ensureExtensionContext()) return false;

  const { force = false, settings, deckRevision = null } = options;
  suspendHighlightMutationObserver();

  try {
    clearScheduledHighlightRun();
    clearScheduledIncrementalHighlightRun();
    pendingIncrementalHighlightRoots = new Set();

    const runId = ++activeHighlightRunId;
    const resolvedSettings =
      settings ||
      (await withExtensionContext(
        () => chrome.storage.local.get(["highlightEnabled", "highlightBlockedUrls", "highlightPageOverrides"]),
        null
      ));
    if (!resolvedSettings) return false;
    if (runId !== activeHighlightRunId) return false;

    const pageOverride = getHighlightPageOverrideForCurrentPage(resolvedSettings.highlightPageOverrides);
    const enabledByRule = !isHighlightBlockedOnCurrentPage(resolvedSettings.highlightBlockedUrls || []);
    const enabled = resolvedSettings.highlightEnabled !== false && (pageOverride === null ? enabledByRule : pageOverride);

    const previousCache = highlightCache;
    const enabledChanged = enabled !== previousCache.enabled;

    if (!enabled) {
      highlightCache = {
        ...previousCache,
        enabled: false
      };
      stopHighlightRuntime();
      if (enabledChanged || hasAppliedHighlights) {
        unwrapHighlights();
      }
      return false;
    }

    let nextCache = {
      ...previousCache,
      enabled
    };

    if (Array.isArray(settings?.highlightEntries)) {
      const nextModel = buildHighlightModel(settings.highlightEntries);
      nextCache = {
        enabled,
        deckRevision: Number.isInteger(deckRevision) ? deckRevision : previousCache.deckRevision,
        matchSignature: nextModel.matchSignature,
        tooltipSignature: nextModel.tooltipSignature,
        regex: nextModel.regex,
        termMeanings: nextModel.termMeanings
      };
    } else if (
      previousCache.deckRevision < 0 ||
      (Number.isInteger(deckRevision) && deckRevision !== previousCache.deckRevision)
    ) {
      const lexiconResponse = await loadHighlightLexiconFromExtension(previousCache.deckRevision);
      if (!lexiconResponse) return false;
      if (runId !== activeHighlightRunId) return false;

      if (Array.isArray(lexiconResponse.entries)) {
        const nextModel = buildHighlightModel(lexiconResponse.entries);
        nextCache = {
          enabled,
          deckRevision: lexiconResponse.revision,
          matchSignature: nextModel.matchSignature,
          tooltipSignature: nextModel.tooltipSignature,
          regex: nextModel.regex,
          termMeanings: nextModel.termMeanings
        };
      } else {
        nextCache = {
          ...previousCache,
          enabled,
          deckRevision: lexiconResponse.revision
        };
      }
    }

    const matchSignatureChanged = nextCache.matchSignature !== previousCache.matchSignature;
    const tooltipSignatureChanged = nextCache.tooltipSignature !== previousCache.tooltipSignature;

    highlightCache = nextCache;

    if (!nextCache.regex) {
      stopHighlightRuntime();
      unwrapHighlights();
      return false;
    }

    startHighlightRuntime();

    if (shouldDeferHighlightForUserInteraction()) {
      scheduleHighlightRun({ force });
      return false;
    }

    if (!force && !enabledChanged && !matchSignatureChanged) {
      if ((tooltipSignatureChanged || enabledChanged) && activeTooltipTarget) {
        showTooltip(activeTooltipTarget);
      }
      return hasAppliedHighlights;
    }

    unwrapHighlights();

    const textNodes = await collectMatchingTextNodes(nextCache.regex, runId);
    if (!textNodes || runId !== activeHighlightRunId) return false;

    const appliedHighlights = await applyHighlightsToTextNodes(textNodes, nextCache.regex, runId);
    if (runId !== activeHighlightRunId) return false;

    hasAppliedHighlights = appliedHighlights;
    return appliedHighlights;
  } finally {
    resumeHighlightMutationObserver();
  }
}

removeStaleInjectedUiElements();
unwrapHighlights({ force: true });
runHighlight().catch(() => {
  // Ignore initial highlight failures to avoid breaking the host page.
});
bindSharedUiEvents();
bindSelectionActionEvents();

rememberCurrentSelection();
const selectionSyncListenerOptions = { signal: pageEventController.signal };
document.addEventListener("selectionchange", rememberCurrentSelection, selectionSyncListenerOptions);
document.addEventListener("mouseup", rememberCurrentSelection, selectionSyncListenerOptions);
document.addEventListener("keyup", rememberCurrentSelection, selectionSyncListenerOptions);

function handleRuntimeMessage(message, _sender, sendResponse) {
  if (!ensureExtensionContext()) return false;

  if (message?.type === "get-selected-text") {
    const selectedText = getCurrentSelectedText() || lastSelectedText;
    sendResponse({ selectedText });
    return true;
  }

  if (message?.type === "refresh-highlight") {
    runHighlight({
      force: true,
      deckRevision: Number.isInteger(message.deckRevision) ? message.deckRevision : null
    })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

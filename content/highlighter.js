const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE"]);
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);
const HIGHLIGHT_REFRESH_DELAY_MS = 80;
const HIGHLIGHT_WALK_BATCH_SIZE = 250;
const HIGHLIGHT_APPLY_BATCH_SIZE = 150;
const SELECTION_SYNC_DELAY_MS = 120;
const SELECTION_ACTION_SETTLE_DELAY_MS = 24;
const INLINE_TRANSLATE_TARGET_LANG = "vi";

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
let highlightCache = {
  enabled: null,
  matchSignature: "",
  tooltipSignature: "",
  regex: null,
  termMeanings: new Map()
};
let inlinePopupState = createInlinePopupState();
let extensionContextAvailable = true;
const pageEventController = new AbortController();

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

function ensureExtensionContext() {
  if (hasLiveExtensionContext()) return true;

  invalidateExtensionContext();
  return false;
}

function removeExtensionListeners() {
  try {
    chrome.storage.onChanged.removeListener(handleStorageChange);
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  } catch {
    // Ignore stale context teardown failures.
  }
}

function invalidateExtensionContext() {
  if (!extensionContextAvailable) return;

  extensionContextAvailable = false;
  pageEventController.abort();
  removeExtensionListeners();
  clearScheduledHighlightRun();
  clearSelectionSync();
  hideSelectionActionUi();
  hideTooltip();
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

function isExtensionUiNode(node) {
  const element = node instanceof Element ? node : node?.parentElement;
  return !!element?.closest(".vocab-selection-bubble, .vocab-inline-translate-popup, .vocab-highlight-tooltip");
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
  if (!selectedText || selectedText === lastSelectedText) return;

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

    if (translated) {
      terms.add(translated);
      addTooltipMeaning(termMeaningSets, translated, source);
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

function isSelectionBubbleVisible() {
  return !!selectionBubbleElement && !selectionBubbleElement.hidden;
}

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
}

function scheduleSelectionUiPosition() {
  if ((!isSelectionBubbleVisible() && !isInlineTranslatePopupVisible()) || selectionUiPositionFrame) return;

  selectionUiPositionFrame = requestAnimationFrame(() => {
    selectionUiPositionFrame = 0;

    if (isSelectionBubbleVisible()) {
      positionFloatingElement(selectionBubbleElement, selectionUiAnchorRect, 22, "below");
    }

    if (isInlineTranslatePopupVisible()) {
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

function bindTooltipEvents() {
  const listenerOptions = { signal: pageEventController.signal };

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

function unwrapHighlights() {
  hideTooltip();

  if (!hasAppliedHighlights) return;

  const nodes = document.querySelectorAll("span.vocab-highlight");
  nodes.forEach((node) => {
    const text = document.createTextNode(node.textContent || "");
    node.replaceWith(text);
  });

  hasAppliedHighlights = false;
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
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

function scheduleHighlightRun(options = {}) {
  const { force = false } = options;
  clearScheduledHighlightRun();

  highlightRefreshTimer = window.setTimeout(() => {
    highlightRefreshTimer = 0;
    runHighlight({ force }).catch(() => {
      // Ignore highlight refresh failures to avoid breaking the host page.
    });
  }, HIGHLIGHT_REFRESH_DELAY_MS);
}

async function runHighlight(options = {}) {
  if (!ensureExtensionContext()) return false;

  const { force = false, settings } = options;
  clearScheduledHighlightRun();

  const runId = ++activeHighlightRunId;
  const resolvedSettings =
    settings ||
    (await withExtensionContext(
      () => chrome.storage.local.get(["highlightEnabled", "deckItems", "highlightBlockedUrls"]),
      null
    ));
  if (!resolvedSettings) return false;
  if (runId !== activeHighlightRunId) return false;

  const enabled =
    resolvedSettings.highlightEnabled !== false &&
    !isHighlightBlockedOnCurrentPage(resolvedSettings.highlightBlockedUrls || []);
  const nextModel = buildHighlightModel(resolvedSettings.deckItems || []);
  const nextCache = {
    enabled,
    matchSignature: nextModel.matchSignature,
    tooltipSignature: nextModel.tooltipSignature,
    regex: nextModel.regex,
    termMeanings: nextModel.termMeanings
  };

  const enabledChanged = enabled !== highlightCache.enabled;
  const matchSignatureChanged = nextCache.matchSignature !== highlightCache.matchSignature;
  const tooltipSignatureChanged = nextCache.tooltipSignature !== highlightCache.tooltipSignature;

  highlightCache = nextCache;

  if (!enabled) {
    if (enabledChanged || hasAppliedHighlights) {
      unwrapHighlights();
    }
    return false;
  }

  if (!force && !enabledChanged && !matchSignatureChanged) {
    if (tooltipSignatureChanged && activeTooltipTarget) {
      showTooltip(activeTooltipTarget);
    }
    return hasAppliedHighlights;
  }

  unwrapHighlights();

  if (!nextCache.regex) {
    return false;
  }

  const textNodes = await collectMatchingTextNodes(nextCache.regex, runId);
  if (!textNodes || runId !== activeHighlightRunId) return false;

  const appliedHighlights = await applyHighlightsToTextNodes(textNodes, nextCache.regex, runId);
  if (runId !== activeHighlightRunId) return false;

  hasAppliedHighlights = appliedHighlights;
  return appliedHighlights;
}

runHighlight().catch(() => {
  // Ignore initial highlight failures to avoid breaking the host page.
});
bindTooltipEvents();
bindSelectionActionEvents();

rememberCurrentSelection();
const selectionSyncListenerOptions = { signal: pageEventController.signal };
document.addEventListener("selectionchange", rememberCurrentSelection, selectionSyncListenerOptions);
document.addEventListener("mouseup", rememberCurrentSelection, selectionSyncListenerOptions);
document.addEventListener("keyup", rememberCurrentSelection, selectionSyncListenerOptions);

function handleStorageChange(changes, area) {
  if (!ensureExtensionContext()) return;

  if (area !== "local") return;
  if (changes.deckItems || changes.highlightEnabled || changes.highlightBlockedUrls) {
    scheduleHighlightRun();
  }
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  if (!ensureExtensionContext()) return false;

  if (message?.type === "get-selected-text") {
    const selectedText = getCurrentSelectedText() || lastSelectedText;
    sendResponse({ selectedText });
    return true;
  }

  if (message?.type === "refresh-highlight") {
    runHighlight({ force: true })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
}

chrome.storage.onChanged.addListener(handleStorageChange);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

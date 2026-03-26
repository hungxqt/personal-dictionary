const GOOGLE_TRANSLATE_API_URL = "https://translation.googleapis.com/language/translate/v2";
const MERRIAM_WEBSTER_THESAURUS_API_URL = "https://www.dictionaryapi.com/api/v3/references/thesaurus/json";

async function requestTranslations({ text, source, target, apiKey }) {
  if (!apiKey) {
    throw new Error("Google API key is missing. Add it in Settings.");
  }

  const queries = (Array.isArray(text) ? text : [text])
    .map((entry) => String(entry ?? ""))
    .filter((entry) => entry.trim());

  if (!queries.length) {
    return [];
  }

  const url = `${GOOGLE_TRANSLATE_API_URL}?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    q: queries.length === 1 ? queries[0] : queries,
    target,
    format: "text"
  };

  if (source && source !== "auto") {
    payload.source = source;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiMessage = data?.error?.message;
    throw new Error(apiMessage || `Translation failed: ${response.status}`);
  }

  return Array.isArray(data?.data?.translations) ? data.data.translations : [];
}

function normalizeThesaurusTerm(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeThesaurusKey(value) {
  return normalizeThesaurusTerm(value)
    .replace(/\*/g, "")
    .toLowerCase();
}

async function requestMerriamWebsterEntries({ text, apiKey }) {
  if (!apiKey) {
    throw new Error("Merriam-Webster API key is missing. Add it in Settings.");
  }

  const queryText = normalizeThesaurusTerm(text);
  if (!queryText) {
    return [];
  }

  const url = `${MERRIAM_WEBSTER_THESAURUS_API_URL}/${encodeURIComponent(queryText)}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(`Thesaurus lookup failed: ${response.status}`);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  if (data.every((entry) => typeof entry === "string")) {
    const suggestions = data.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, 5);
    if (suggestions.length) {
      throw new Error(`No thesaurus entry found. Suggestions: ${suggestions.join(", ")}`);
    }

    throw new Error("No thesaurus entry found.");
  }

  return data.filter((entry) => entry && typeof entry === "object");
}

function collectThesaurusTerms(entries, text, metaKey) {
  const normalizedSourceText = normalizeThesaurusKey(text);
  const terms = [];
  const seenTerms = new Set();

  for (const entry of entries) {
    const groups = Array.isArray(entry?.meta?.[metaKey]) ? entry.meta[metaKey] : [];

    for (const group of groups) {
      if (!Array.isArray(group)) continue;

      for (const rawTerm of group) {
        const term = normalizeThesaurusTerm(rawTerm);
        const termKey = normalizeThesaurusKey(term);

        if (!term || termKey === normalizedSourceText || seenTerms.has(termKey)) {
          continue;
        }

        seenTerms.add(termKey);
        terms.push(term);
      }
    }
  }

  return terms;
}

export async function translateTextDetailed({ text, source, target, apiKey }) {
  const translation = (await requestTranslations({ text, source, target, apiKey }))[0] || {};

  return {
    translatedText: translation.translatedText || "",
    detectedSourceLanguage: translation.detectedSourceLanguage || ""
  };
}

export async function translateTextList({ texts, source, target, apiKey }) {
  const normalizedTexts = Array.isArray(texts)
    ? texts.map((entry) => String(entry ?? "")).filter((entry) => entry.trim())
    : [];

  if (!normalizedTexts.length) {
    return [];
  }

  try {
    const translations = await requestTranslations({ text: normalizedTexts, source, target, apiKey });
    if (translations.length === normalizedTexts.length) {
      return translations.map((translation) => translation?.translatedText || "");
    }
  } catch (error) {
    if (normalizedTexts.length <= 1) {
      throw error;
    }
  }

  const fallbackResults = [];
  for (const text of normalizedTexts) {
    const translation = (await requestTranslations({ text, source, target, apiKey }))[0] || {};
    fallbackResults.push(translation.translatedText || "");
  }

  return fallbackResults;
}

export async function lookupSourceSynonyms({ text, apiKey }) {
  const entries = await requestMerriamWebsterEntries({ text, apiKey });
  return collectThesaurusTerms(entries, text, "syns");
}

export async function lookupSourceAntonyms({ text, apiKey }) {
  const entries = await requestMerriamWebsterEntries({ text, apiKey });
  return collectThesaurusTerms(entries, text, "ants");
}

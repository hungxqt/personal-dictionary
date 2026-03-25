const GOOGLE_TRANSLATE_API_URL = "https://translation.googleapis.com/language/translate/v2";
const MICROSOFT_TRANSLATOR_API_URL = "https://api.cognitive.microsofttranslator.com";

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

function normalizeTranslatorLanguage(value) {
  return String(value ?? "").trim().toLowerCase();
}

async function requestDictionaryLookup({ text, source, target, apiKey, region = "" }) {
  if (!apiKey) {
    throw new Error("Microsoft Translator API key is missing. Add it in Settings.");
  }

  const normalizedSource = normalizeTranslatorLanguage(source);
  const normalizedTarget = normalizeTranslatorLanguage(target);

  if (!normalizedSource || normalizedSource === "auto") {
    throw new Error("Synonyms require a specific source language.");
  }

  if (!normalizedTarget || normalizedTarget === "auto") {
    throw new Error("Synonyms require a specific target language.");
  }

  const query = new URLSearchParams({
    "api-version": "3.0",
    from: normalizedSource,
    to: normalizedTarget
  });

  const headers = {
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": apiKey,
    "X-ClientTraceId": globalThis.crypto?.randomUUID?.() || String(Date.now())
  };

  const normalizedRegion = String(region ?? "").trim();
  if (normalizedRegion) {
    headers["Ocp-Apim-Subscription-Region"] = normalizedRegion;
  }

  const response = await fetch(`${MICROSOFT_TRANSLATOR_API_URL}/dictionary/lookup?${query.toString()}`, {
    method: "POST",
    headers,
    body: JSON.stringify([{ Text: text }])
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiMessage = data?.error?.message;
    throw new Error(apiMessage || `Synonym lookup failed: ${response.status}`);
  }

  return Array.isArray(data) ? data[0] || {} : {};
}

export async function translateTextDetailed({ text, source, target, apiKey }) {
  const translation = (await requestTranslations({ text, source, target, apiKey }))[0] || {};

  return {
    translatedText: translation.translatedText || "",
    detectedSourceLanguage: translation.detectedSourceLanguage || ""
  };
}

export async function translateText({ text, source, target, apiKey }) {
  const translation = await translateTextDetailed({ text, source, target, apiKey });
  return translation.translatedText;
}

export async function translateTextList({ texts, source, target, apiKey }) {
  const translations = await requestTranslations({ text: texts, source, target, apiKey });
  return translations.map((translation) => translation?.translatedText || "");
}

export async function lookupSourceSynonyms({ text, source, target, apiKey, region = "" }) {
  const lookupResult = await requestDictionaryLookup({ text, source, target, apiKey, region });
  const normalizedSourceText = String(text ?? "").trim().toLowerCase();
  const scoredSynonyms = [];
  const seenSynonyms = new Set();

  for (const translation of lookupResult?.translations || []) {
    for (const backTranslation of translation?.backTranslations || []) {
      const synonym = String(
        backTranslation?.displayText || backTranslation?.normalizedText || backTranslation?.text || ""
      ).trim();
      const synonymKey = synonym.toLowerCase();

      if (!synonym || synonymKey === normalizedSourceText || seenSynonyms.has(synonymKey)) {
        continue;
      }

      seenSynonyms.add(synonymKey);
      scoredSynonyms.push({
        text: synonym,
        frequencyCount: Number(backTranslation?.frequencyCount || 0),
        numExamples: Number(backTranslation?.numExamples || 0)
      });
    }
  }

  scoredSynonyms.sort((left, right) => {
    if (right.frequencyCount !== left.frequencyCount) {
      return right.frequencyCount - left.frequencyCount;
    }

    if (right.numExamples !== left.numExamples) {
      return right.numExamples - left.numExamples;
    }

    return left.text.localeCompare(right.text);
  });

  return scoredSynonyms.map((entry) => entry.text);
}

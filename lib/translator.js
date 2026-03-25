const API_URL = "https://translation.googleapis.com/language/translate/v2";

async function requestTranslation({ text, source, target, apiKey }) {
  if (!apiKey) {
    throw new Error("Google API key is missing. Add it in Settings.");
  }

  const url = `${API_URL}?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    q: text,
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

  return data?.data?.translations?.[0] || {};
}

export async function translateTextDetailed({ text, source, target, apiKey }) {
  const translation = await requestTranslation({ text, source, target, apiKey });

  return {
    translatedText: translation.translatedText || "",
    detectedSourceLanguage: translation.detectedSourceLanguage || ""
  };
}

export async function translateText({ text, source, target, apiKey }) {
  const translation = await translateTextDetailed({ text, source, target, apiKey });
  return translation.translatedText;
}

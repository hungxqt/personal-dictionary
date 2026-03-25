const DB_META_KEY = "dbMeta";
const DB_DEFAULT_FILE = "database.db";
const DECK_KEY = "deckItems";

async function readFileText(fileHandle) {
  const file = await fileHandle.getFile();
  return await file.text();
}

async function writeFileText(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function makeEmptyDb() {
  return {
    version: 1,
    deck: []
  };
}

function normalizeDb(raw) {
  const db = raw && typeof raw === "object" ? raw : makeEmptyDb();
  if (!Array.isArray(db.deck)) db.deck = [];
  if (!db.version) db.version = 1;
  return db;
}

async function getDbMeta() {
  const data = await chrome.storage.local.get(DB_META_KEY);
  return data[DB_META_KEY] || { mode: "storage" };
}

async function setDbMeta(meta) {
  await chrome.storage.local.set({ [DB_META_KEY]: meta });
}

async function loadFromStorageFallback() {
  const data = await chrome.storage.local.get(DECK_KEY);
  return normalizeDb({ version: 1, deck: data[DECK_KEY] || [] });
}

async function saveToStorageFallback(db) {
  await chrome.storage.local.set({ [DECK_KEY]: db.deck || [] });
}

export async function initializeDatabase() {
  const meta = await getDbMeta();
  if (meta.mode === "custom") {
    const permission = await meta.fileHandle?.queryPermission?.({ mode: "readwrite" });
    if (permission !== "granted") {
      await setDbMeta({ mode: "storage" });
      return;
    }

    try {
      const text = await readFileText(meta.fileHandle);
      if (!text.trim()) {
        await writeFileText(meta.fileHandle, JSON.stringify(makeEmptyDb(), null, 2));
      }
    } catch {
      await writeFileText(meta.fileHandle, JSON.stringify(makeEmptyDb(), null, 2));
    }
    return;
  }

  const fallback = await loadFromStorageFallback();
  if (!Array.isArray(fallback.deck)) {
    await saveToStorageFallback(makeEmptyDb());
  }
}

export async function chooseCustomDatabaseFile() {
  if (!window.showSaveFilePicker) {
    throw new Error("Your browser does not support file picker in this context.");
  }

  const fileHandle = await window.showSaveFilePicker({
    suggestedName: DB_DEFAULT_FILE,
    types: [
      {
        description: "Database File",
        accept: { "application/octet-stream": [".db", ".json"] }
      }
    ]
  });

  const permission = await fileHandle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Permission denied for selected database file.");
  }

  let db;
  try {
    const text = await readFileText(fileHandle);
    db = text.trim() ? normalizeDb(JSON.parse(text)) : makeEmptyDb();
  } catch {
    db = makeEmptyDb();
  }

  await writeFileText(fileHandle, JSON.stringify(db, null, 2));
  await setDbMeta({ mode: "custom", fileHandle });
}

export async function useDefaultDatabaseLocation() {
  await setDbMeta({ mode: "storage" });
}

export async function getDatabaseLocationLabel() {
  const meta = await getDbMeta();
  if (meta.mode === "custom") {
    return "Custom file (database.db or selected file)";
  }
  return "Default extension storage (internal database.db mode)";
}

export async function readDeckItems() {
  const meta = await getDbMeta();

  if (meta.mode === "custom" && meta.fileHandle) {
    const permission = await meta.fileHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      await setDbMeta({ mode: "storage" });
      const fallback = await loadFromStorageFallback();
      return fallback.deck;
    }

    try {
      const text = await readFileText(meta.fileHandle);
      const db = text.trim() ? normalizeDb(JSON.parse(text)) : makeEmptyDb();
      return db.deck;
    } catch {
      return [];
    }
  }

  const fallback = await loadFromStorageFallback();
  return fallback.deck;
}

export async function writeDeckItems(items) {
  const meta = await getDbMeta();
  const db = normalizeDb({ version: 1, deck: items });

  if (meta.mode === "custom" && meta.fileHandle) {
    const permission = await meta.fileHandle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      await writeFileText(meta.fileHandle, JSON.stringify(db, null, 2));
      return;
    }

    await setDbMeta({ mode: "storage" });
  }

  await saveToStorageFallback(db);
}

export function createDeckItem({ sourceText, translatedText, sourceLang, targetLang }) {
  return {
    id: crypto.randomUUID(),
    sourceText,
    translatedText,
    sourceLang,
    targetLang,
    createdAt: new Date().toISOString()
  };
}

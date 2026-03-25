const DB_META_KEY = "dbMeta";
const DB_DEFAULT_FILE = "database.db";
const DECK_KEY = "deckItems";
const HANDLE_DB_NAME = "vocab-translator-handles";
const HANDLE_STORE_NAME = "handles";
const CUSTOM_DB_HANDLE_KEY = "customDatabaseFileHandle";

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

async function openHandleDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable in this context.");
  }

  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        database.createObjectStore(HANDLE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the handle database."));
  });
}

async function readStoredCustomFileHandle() {
  let database;

  try {
    database = await openHandleDatabase();
  } catch {
    return null;
  }

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, "readonly");
      const request = transaction.objectStore(HANDLE_STORE_NAME).get(CUSTOM_DB_HANDLE_KEY);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the stored file handle."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not read the stored file handle."));
    });
  } finally {
    database.close();
  }
}

async function writeStoredCustomFileHandle(fileHandle) {
  const database = await openHandleDatabase();

  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, "readwrite");
      transaction.objectStore(HANDLE_STORE_NAME).put(fileHandle, CUSTOM_DB_HANDLE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not store the file handle."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not store the file handle."));
    });
  } finally {
    database.close();
  }
}

async function clearStoredCustomFileHandle() {
  let database;

  try {
    database = await openHandleDatabase();
  } catch {
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, "readwrite");
      transaction.objectStore(HANDLE_STORE_NAME).delete(CUSTOM_DB_HANDLE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear the file handle."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not clear the file handle."));
    });
  } finally {
    database.close();
  }
}

async function getDbMeta() {
  const data = await chrome.storage.local.get(DB_META_KEY);
  const meta = data[DB_META_KEY] || { mode: "storage" };

  if (meta.mode === "custom") {
    meta.fileHandle = await readStoredCustomFileHandle();
  }

  return meta;
}

async function setDbMeta(meta) {
  const nextMeta = { ...meta };
  const fileHandle = nextMeta.fileHandle || null;
  delete nextMeta.fileHandle;

  if (nextMeta.mode === "custom" && fileHandle) {
    await writeStoredCustomFileHandle(fileHandle);
  } else if (nextMeta.mode !== "custom") {
    await clearStoredCustomFileHandle();
  }

  await chrome.storage.local.set({ [DB_META_KEY]: nextMeta });
}

async function loadFromStorageFallback() {
  const data = await chrome.storage.local.get(DECK_KEY);
  return normalizeDb({ version: 1, deck: data[DECK_KEY] || [] });
}

async function saveToStorageFallback(db) {
  await chrome.storage.local.set({ [DECK_KEY]: db.deck || [] });
}

async function hasFileHandlePermission(fileHandle, { request = false } = {}) {
  if (!fileHandle) return false;

  const options = { mode: "readwrite" };

  try {
    if ((await fileHandle.queryPermission?.(options)) === "granted") {
      return true;
    }
  } catch {
    return false;
  }

  if (!request) {
    return false;
  }

  try {
    return (await fileHandle.requestPermission?.(options)) === "granted";
  } catch {
    return false;
  }
}

export async function initializeDatabase() {
  const meta = await getDbMeta();
  if (meta.mode === "custom") {
    if (!meta.fileHandle) {
      return;
    }

    const permissionGranted = await hasFileHandlePermission(meta.fileHandle);
    if (!permissionGranted) {
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

  const currentDeckItems = await readDeckItems();

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
    db = text.trim()
      ? normalizeDb(JSON.parse(text))
      : normalizeDb({ version: 1, deck: currentDeckItems });
  } catch {
    db = normalizeDb({ version: 1, deck: currentDeckItems });
  }

  await writeFileText(fileHandle, JSON.stringify(db, null, 2));
  await saveToStorageFallback(db);
  await setDbMeta({ mode: "custom", fileHandle, fileName: fileHandle.name || DB_DEFAULT_FILE });
}

export async function useDefaultDatabaseLocation() {
  await setDbMeta({ mode: "storage" });
}

export async function getDatabaseLocationInfo() {
  const meta = await getDbMeta();
  if (meta.mode === "custom") {
    const fileName = String(meta.fileHandle?.name || meta.fileName || DB_DEFAULT_FILE).trim() || DB_DEFAULT_FILE;
    return {
      summary: `Deck is saved in the selected custom file: ${fileName}.`,
      detail: `Custom file: ${fileName}`
    };
  }

  return {
    summary: "Deck is saved in the default extension storage.",
    detail: "Default extension storage (internal database.db mode)"
  };
}

export async function getDatabaseLocationLabel() {
  const info = await getDatabaseLocationInfo();
  return info.detail;
}

export async function readDeckItems() {
  const meta = await getDbMeta();

  if (meta.mode === "custom" && meta.fileHandle) {
    const permissionGranted = await hasFileHandlePermission(meta.fileHandle);
    if (!permissionGranted) {
      const fallback = await loadFromStorageFallback();
      return fallback.deck;
    }

    try {
      const text = await readFileText(meta.fileHandle);
      const db = text.trim() ? normalizeDb(JSON.parse(text)) : makeEmptyDb();
      await saveToStorageFallback(db);
      return db.deck;
    } catch {
      const fallback = await loadFromStorageFallback();
      return fallback.deck;
    }
  }

  const fallback = await loadFromStorageFallback();
  return fallback.deck;
}

export async function writeDeckItems(items, options = {}) {
  const { allowStorageFallback = false } = options;
  const meta = await getDbMeta();
  const db = normalizeDb({ version: 1, deck: items });

  if (meta.mode === "custom" && meta.fileHandle) {
    const permissionGranted = await hasFileHandlePermission(meta.fileHandle, { request: true });
    if (permissionGranted) {
      await writeFileText(meta.fileHandle, JSON.stringify(db, null, 2));
      await saveToStorageFallback(db);
      return;
    }

    // Background inline saves may not be able to re-request a stale file permission, so keep the deck in storage.
    if (allowStorageFallback) {
      await saveToStorageFallback(db);
      return;
    }

    throw new Error("Custom database access needs permission again. Open the popup and reselect the custom file if needed.");
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

const DB_NAME = "vocab-translator-db";
const DB_VERSION = 1;
const DECK_STORE_NAME = "deck_items";
const META_STORE_NAME = "meta";
const DB_DEFAULT_FILE = "database.db";
const LEGACY_DB_META_KEY = "dbMeta";
const LEGACY_DECK_KEY = "deckItems";
const LEGACY_HANDLE_DB_NAME = "vocab-translator-handles";
const LEGACY_HANDLE_STORE_NAME = "handles";
const LEGACY_CUSTOM_DB_HANDLE_KEY = "customDatabaseFileHandle";
const META_KEY_DECK_REVISION = "deckRevision";
const META_KEY_MIGRATION_VERSION = "migrationVersion";
const META_KEY_SYNC_FILE_HANDLE = "syncFileHandle";
const META_KEY_SYNC_FILE_NAME = "syncFileName";
const META_KEY_MIGRATION_NOTICE = "migrationNotice";
const CURRENT_MIGRATION_VERSION = 1;
const SUPPORTED_SORT_ORDERS = new Set(["newest", "oldest", "source-asc", "source-desc"]);

let databasePromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeLanguageCode(value, fallback) {
  return String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") || fallback;
}

function normalizeSearchText(value) {
  return normalizeText(value).toLowerCase();
}

function createDuplicateDeckSourceError(existingItem = null) {
  const error = new Error("A deck item with the same source text already exists.");
  error.name = "DuplicateDeckSourceError";

  if (existingItem) {
    error.existingItem = existingItem;
  }

  return error;
}

function normalizeCreatedAt(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function validateSortOrder(value) {
  return SUPPORTED_SORT_ORDERS.has(value) ? value : "newest";
}

function createFilePayload(items) {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    deck: items
  };
}

function normalizeDbPayload(raw) {
  if (Array.isArray(raw)) {
    return { version: 2, deck: raw };
  }

  const payload = raw && typeof raw === "object" ? raw : createFilePayload([]);
  const deck = Array.isArray(payload.deck)
    ? payload.deck
    : Array.isArray(payload.deckItems)
      ? payload.deckItems
      : Array.isArray(payload.items)
        ? payload.items
        : [];

  return {
    version: Number(payload.version) || 2,
    deck
  };
}

function sanitizeDeckItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const sourceText = normalizeText(rawItem.sourceText);
  const translatedText = normalizeText(rawItem.translatedText);
  if (!sourceText || !translatedText) return null;

  const normalizedId = typeof rawItem.id === "string" ? rawItem.id.trim() : "";
  const id = normalizedId || crypto.randomUUID();

  return {
    id,
    sourceText,
    translatedText,
    sourceLang: normalizeLanguageCode(rawItem.sourceLang, "auto"),
    targetLang: normalizeLanguageCode(rawItem.targetLang, "vi"),
    createdAt: normalizeCreatedAt(rawItem.createdAt),
    sourceTextNormalized: normalizeSearchText(sourceText),
    translatedTextNormalized: normalizeSearchText(translatedText)
  };
}

function toPublicDeckItem(rawItem) {
  const sanitized = sanitizeDeckItem(rawItem);
  if (!sanitized) return null;

  return {
    id: sanitized.id,
    sourceText: sanitized.sourceText,
    translatedText: sanitized.translatedText,
    sourceLang: sanitized.sourceLang,
    targetLang: sanitized.targetLang,
    createdAt: sanitized.createdAt
  };
}

async function findDeckRecordByNormalizedSourceTextInStore(store, sourceTextNormalized, excludeId = "") {
  const normalizedSourceText = normalizeSearchText(sourceTextNormalized);
  if (!normalizedSourceText) return null;

  const normalizedExcludedId = String(excludeId || "").trim();
  const sourceIndex = store.index("sourceTextNormalized");

  return await new Promise((resolve, reject) => {
    const request = sourceIndex.openCursor(IDBKeyRange.only(normalizedSourceText), "next");

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(null);
        return;
      }

      const candidate = cursor.value;
      if (String(candidate?.id || "") === normalizedExcludedId) {
        cursor.continue();
        return;
      }

      resolve(candidate || null);
    };

    request.onerror = () => reject(request.error || new Error("Could not search deck items by source text."));
  });
}

function compareDeckItems(left, right, sortOrder = "newest") {
  const leftCreatedAt = String(left?.createdAt || "");
  const rightCreatedAt = String(right?.createdAt || "");
  const leftSource = normalizeSearchText(left?.sourceText);
  const rightSource = normalizeSearchText(right?.sourceText);
  const leftId = String(left?.id || "");
  const rightId = String(right?.id || "");

  if (sortOrder === "oldest") {
    const createdAtDiff = leftCreatedAt.localeCompare(rightCreatedAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return leftId.localeCompare(rightId);
  }

  if (sortOrder === "source-asc") {
    const sourceDiff = leftSource.localeCompare(rightSource);
    if (sourceDiff !== 0) return sourceDiff;
    const createdAtDiff = rightCreatedAt.localeCompare(leftCreatedAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return leftId.localeCompare(rightId);
  }

  if (sortOrder === "source-desc") {
    const sourceDiff = rightSource.localeCompare(leftSource);
    if (sourceDiff !== 0) return sourceDiff;
    const createdAtDiff = rightCreatedAt.localeCompare(leftCreatedAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return rightId.localeCompare(leftId);
  }

  const createdAtDiff = rightCreatedAt.localeCompare(leftCreatedAt);
  if (createdAtDiff !== 0) return createdAtDiff;
  return rightId.localeCompare(leftId);
}

function pickQuerySource(store, sortOrder) {
  if (sortOrder === "oldest" || sortOrder === "newest") {
    return {
      source: store.index("createdAt"),
      direction: sortOrder === "oldest" ? "next" : "prev"
    };
  }

  return {
    source: store.index("sourceTextNormalized"),
    direction: sortOrder === "source-desc" ? "prev" : "next"
  };
}

async function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable in this context.");
  }

  databasePromise = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;

      let deckStore;
      if (!database.objectStoreNames.contains(DECK_STORE_NAME)) {
        deckStore = database.createObjectStore(DECK_STORE_NAME, { keyPath: "id" });
      } else {
        deckStore = transaction.objectStore(DECK_STORE_NAME);
      }

      if (!deckStore.indexNames.contains("createdAt")) {
        deckStore.createIndex("createdAt", "createdAt");
      }
      if (!deckStore.indexNames.contains("sourceTextNormalized")) {
        deckStore.createIndex("sourceTextNormalized", "sourceTextNormalized");
      }
      if (!deckStore.indexNames.contains("translatedTextNormalized")) {
        deckStore.createIndex("translatedTextNormalized", "translatedTextNormalized");
      }

      if (!database.objectStoreNames.contains(META_STORE_NAME)) {
        database.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error("Could not open the deck database."));
    };
  });

  return databasePromise;
}

async function readMetaValues(keys) {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE_NAME, "readonly");
  const store = transaction.objectStore(META_STORE_NAME);
  const entries = await Promise.all(keys.map((key) => requestToPromise(store.get(key))));
  await waitForTransaction(transaction);

  const result = Object.create(null);
  keys.forEach((key, index) => {
    result[key] = entries[index]?.value;
  });
  return result;
}

async function readMetaValue(key, fallbackValue = null) {
  const values = await readMetaValues([key]);
  return values[key] ?? fallbackValue;
}

async function writeMetaValues(entries) {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE_NAME, "readwrite");
  const store = transaction.objectStore(META_STORE_NAME);

  for (const [key, value] of Object.entries(entries)) {
    store.put({ key, value });
  }

  await waitForTransaction(transaction);
}

async function readFileText(fileHandle) {
  const file = await fileHandle.getFile();
  return await file.text();
}

async function writeFileText(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
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

async function openLegacyHandleDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable in this context.");
  }

  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_HANDLE_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the legacy handle database."));
  });
}

async function readLegacyCustomFileHandle() {
  let database;

  try {
    database = await openLegacyHandleDatabase();
  } catch {
    return null;
  }

  try {
    return await new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = database.transaction(LEGACY_HANDLE_STORE_NAME, "readonly");
      } catch {
        resolve(null);
        return;
      }

      const request = transaction.objectStore(LEGACY_HANDLE_STORE_NAME).get(LEGACY_CUSTOM_DB_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the legacy custom database handle."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not read the legacy custom database handle."));
    });
  } finally {
    database.close();
  }
}

async function getDeckCount() {
  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const count = await requestToPromise(transaction.objectStore(DECK_STORE_NAME).count());
  await waitForTransaction(transaction);
  return Number(count) || 0;
}

async function setRevisionInTransaction(metaStore, revision) {
  metaStore.put({ key: META_KEY_DECK_REVISION, value: revision });
  metaStore.put({ key: META_KEY_MIGRATION_VERSION, value: CURRENT_MIGRATION_VERSION });
}

async function getCurrentRevisionInTransaction(metaStore) {
  const record = await requestToPromise(metaStore.get(META_KEY_DECK_REVISION));
  return Number.isInteger(record?.value) ? record.value : 0;
}

async function runDeckMutation(mutator) {
  const database = await openDatabase();
  const transaction = database.transaction([DECK_STORE_NAME, META_STORE_NAME], "readwrite");
  const deckStore = transaction.objectStore(DECK_STORE_NAME);
  const metaStore = transaction.objectStore(META_STORE_NAME);

  try {
    const currentRevision = await getCurrentRevisionInTransaction(metaStore);
    const mutationResult = (await mutator({ deckStore, metaStore, currentRevision, transaction })) || {};

    if (!mutationResult.skipRevision) {
      const nextRevision = currentRevision + 1;
      await setRevisionInTransaction(metaStore, nextRevision);
      mutationResult.revision = nextRevision;
    } else {
      mutationResult.revision = currentRevision;
    }

    await waitForTransaction(transaction);
    return mutationResult;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // Ignore abort failures if the transaction is already completed.
    }

    throw error;
  }
}

async function listDeckRecords(indexName = null, direction = "next") {
  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const store = transaction.objectStore(DECK_STORE_NAME);
  const source = indexName ? store.index(indexName) : store;
  const items = [];

  await new Promise((resolve, reject) => {
    const request = source.openCursor(null, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      items.push(toPublicDeckItem(cursor.value));
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not list deck records."));
  });

  await waitForTransaction(transaction);
  return items.filter(Boolean);
}

async function collectPrefixMatches(index, prefix, matches) {
  const keyRange = IDBKeyRange.bound(prefix, `${prefix}\uffff`);

  await new Promise((resolve, reject) => {
    const request = index.openCursor(keyRange, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const item = toPublicDeckItem(cursor.value);
      if (item) {
        matches.set(item.id, item);
      }

      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not search the deck index."));
  });
}

async function queryDeckItemsWithoutSearch({ page, pageSize, sort }) {
  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const store = transaction.objectStore(DECK_STORE_NAME);
  const total = Number(await requestToPromise(store.count())) || 0;
  const offset = (page - 1) * pageSize;
  const items = [];

  if (!total || offset >= total) {
    await waitForTransaction(transaction);
    return { items, total };
  }

  const { source, direction } = pickQuerySource(store, sort);
  let skipped = offset === 0;

  await new Promise((resolve, reject) => {
    const request = source.openCursor(null, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      if (!skipped) {
        skipped = true;
        cursor.advance(offset);
        return;
      }

      const item = toPublicDeckItem(cursor.value);
      if (item) {
        items.push(item);
      }

      if (items.length >= pageSize) {
        resolve();
        return;
      }

      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not query deck items."));
  });

  await waitForTransaction(transaction);
  return { items, total };
}

async function queryDeckItemsWithSearch({ page, pageSize, sort, query }) {
  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const store = transaction.objectStore(DECK_STORE_NAME);
  const matches = new Map();

  await collectPrefixMatches(store.index("sourceTextNormalized"), query, matches);
  await collectPrefixMatches(store.index("translatedTextNormalized"), query, matches);
  await waitForTransaction(transaction);

  const sortedItems = [...matches.values()].sort((left, right) => compareDeckItems(left, right, sort));
  const total = sortedItems.length;
  const startIndex = (page - 1) * pageSize;

  return {
    items: sortedItems.slice(startIndex, startIndex + pageSize),
    total
  };
}

async function migrateLegacyDataIfNeeded() {
  const migrationVersion = await readMetaValue(META_KEY_MIGRATION_VERSION, 0);
  if ((Number(migrationVersion) || 0) >= CURRENT_MIGRATION_VERSION) {
    return;
  }

  const existingCount = await getDeckCount();
  if (existingCount > 0) {
    const currentRevision = await readMetaValue(META_KEY_DECK_REVISION, 0);
    await writeMetaValues({
      [META_KEY_MIGRATION_VERSION]: CURRENT_MIGRATION_VERSION,
      [META_KEY_DECK_REVISION]: Number(currentRevision) || 1
    });
    return;
  }

  const legacyData = await chrome.storage.local.get([LEGACY_DECK_KEY, LEGACY_DB_META_KEY]);
  const legacyDeckItems = Array.isArray(legacyData[LEGACY_DECK_KEY]) ? legacyData[LEGACY_DECK_KEY] : [];
  const legacyMeta =
    legacyData[LEGACY_DB_META_KEY] && typeof legacyData[LEGACY_DB_META_KEY] === "object"
      ? legacyData[LEGACY_DB_META_KEY]
      : { mode: "storage" };

  let sourceItems = legacyDeckItems;
  let migrationNotice = "";
  let syncFileHandle = null;
  let syncFileName = "";

  if (legacyMeta.mode === "custom") {
    const legacyFileHandle = await readLegacyCustomFileHandle();
    const candidateFileName = normalizeText(legacyFileHandle?.name || legacyMeta.fileName || DB_DEFAULT_FILE) || DB_DEFAULT_FILE;

    if (legacyFileHandle && (await hasFileHandlePermission(legacyFileHandle))) {
      try {
        const fileText = await readFileText(legacyFileHandle);
        sourceItems = normalizeDbPayload(fileText.trim() ? JSON.parse(fileText) : createFilePayload([])).deck;
        syncFileHandle = legacyFileHandle;
        syncFileName = candidateFileName;
      } catch {
        migrationNotice = `Could not read the previous custom database file "${candidateFileName}". The internal deck backup was used instead.`;
      }
    } else {
      migrationNotice = `The previous custom database file "${candidateFileName}" needs permission again. Re-import it or choose it as the manual sync file in Settings.`;
    }
  }

  const sanitizedItems = sourceItems.map((item) => sanitizeDeckItem(item)).filter(Boolean);
  const database = await openDatabase();
  const transaction = database.transaction([DECK_STORE_NAME, META_STORE_NAME], "readwrite");
  const deckStore = transaction.objectStore(DECK_STORE_NAME);
  const metaStore = transaction.objectStore(META_STORE_NAME);

  deckStore.clear();
  for (const item of sanitizedItems) {
    deckStore.put(item);
  }

  metaStore.put({
    key: META_KEY_DECK_REVISION,
    value: sanitizedItems.length ? 1 : 0
  });
  metaStore.put({
    key: META_KEY_MIGRATION_VERSION,
    value: CURRENT_MIGRATION_VERSION
  });
  metaStore.put({
    key: META_KEY_SYNC_FILE_HANDLE,
    value: syncFileHandle
  });
  metaStore.put({
    key: META_KEY_SYNC_FILE_NAME,
    value: syncFileName
  });
  metaStore.put({
    key: META_KEY_MIGRATION_NOTICE,
    value: migrationNotice
  });

  await waitForTransaction(transaction);
}

export async function initializeDatabase() {
  await openDatabase();
  await migrateLegacyDataIfNeeded();
}

export async function queryDeckItems(options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.max(1, Number(options.pageSize) || 10);
  const sort = validateSortOrder(options.sort);
  const query = normalizeSearchText(options.query);

  if (!query) {
    return await queryDeckItemsWithoutSearch({ page, pageSize, sort });
  }

  return await queryDeckItemsWithSearch({ page, pageSize, sort, query });
}

export async function getDeckItem(id) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;

  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const item = await requestToPromise(transaction.objectStore(DECK_STORE_NAME).get(normalizedId));
  await waitForTransaction(transaction);
  return toPublicDeckItem(item);
}

export async function listAllDeckItems() {
  return await listDeckRecords("createdAt", "prev");
}

export async function findDeckItemBySourceText(sourceText, options = {}) {
  const normalizedSourceText = normalizeSearchText(sourceText);
  if (!normalizedSourceText) return null;

  const excludeId = String(options.excludeId || "").trim();
  const database = await openDatabase();
  const transaction = database.transaction(DECK_STORE_NAME, "readonly");
  const deckStore = transaction.objectStore(DECK_STORE_NAME);
  const matchingItem = await findDeckRecordByNormalizedSourceTextInStore(deckStore, normalizedSourceText, excludeId);
  await waitForTransaction(transaction);
  return toPublicDeckItem(matchingItem);
}

export async function upsertDeckItem(item) {
  const sanitized = sanitizeDeckItem(item);
  if (!sanitized) {
    throw new Error("Deck items must include both sourceText and translatedText.");
  }

  const result = await runDeckMutation(async ({ deckStore }) => {
    const existingRecord = await requestToPromise(deckStore.get(sanitized.id));
    const sourceTextChanged = !existingRecord || existingRecord.sourceTextNormalized !== sanitized.sourceTextNormalized;

    if (sourceTextChanged) {
      const duplicateItem = await findDeckRecordByNormalizedSourceTextInStore(
        deckStore,
        sanitized.sourceTextNormalized,
        sanitized.id
      );

      if (duplicateItem) {
        throw createDuplicateDeckSourceError(toPublicDeckItem(duplicateItem));
      }
    }

    deckStore.put(sanitized);
    return {
      item: toPublicDeckItem(sanitized)
    };
  });

  return result;
}

export async function replaceDeckItems(items) {
  const sanitizedItems = (Array.isArray(items) ? items : []).map((item) => sanitizeDeckItem(item)).filter(Boolean);

  const result = await runDeckMutation(({ deckStore }) => {
    deckStore.clear();
    for (const item of sanitizedItems) {
      deckStore.put(item);
    }

    return {
      count: sanitizedItems.length
    };
  });

  return result;
}

export async function deleteDeckItems(ids) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) {
    return {
      deletedIds: [],
      revision: await getDeckRevision()
    };
  }

  const result = await runDeckMutation(({ deckStore }) => {
    uniqueIds.forEach((id) => {
      deckStore.delete(id);
    });

    return {
      deletedIds: uniqueIds
    };
  });

  return result;
}

export async function getDeckRevision() {
  return Number(await readMetaValue(META_KEY_DECK_REVISION, 0)) || 0;
}

export async function getHighlightLexicon(options = {}) {
  const sinceRevision = Number.isInteger(options.sinceRevision) ? options.sinceRevision : null;
  const revision = await getDeckRevision();
  if (sinceRevision !== null && sinceRevision === revision) {
    return {
      revision,
      entries: null
    };
  }

  const items = await listAllDeckItems();
  return {
    revision,
    entries: items.map((item) => ({
      sourceText: item.sourceText,
      translatedText: item.translatedText
    }))
  };
}

export async function chooseDatabaseSyncFile() {
  if (!globalThis.showSaveFilePicker) {
    throw new Error("Your browser does not support file picker in this context.");
  }

  const fileHandle = await globalThis.showSaveFilePicker({
    suggestedName: DB_DEFAULT_FILE,
    types: [
      {
        description: "Database File",
        accept: {
          "application/octet-stream": [".db"],
          "application/json": [".json"]
        }
      }
    ]
  });

  const permissionGranted = await hasFileHandlePermission(fileHandle, { request: true });
  if (!permissionGranted) {
    throw new Error("Permission denied for selected database file.");
  }

  await writeMetaValues({
    [META_KEY_SYNC_FILE_HANDLE]: fileHandle,
    [META_KEY_SYNC_FILE_NAME]: normalizeText(fileHandle.name) || DB_DEFAULT_FILE,
    [META_KEY_MIGRATION_NOTICE]: ""
  });

  return await getDatabaseLocationInfo();
}

export async function syncDatabaseToFile(options = {}) {
  const { requestPermission = true } = options;
  const meta = await readMetaValues([META_KEY_SYNC_FILE_HANDLE, META_KEY_SYNC_FILE_NAME]);
  const fileHandle = meta[META_KEY_SYNC_FILE_HANDLE] || null;
  const fileName = normalizeText(meta[META_KEY_SYNC_FILE_NAME]) || DB_DEFAULT_FILE;

  if (!fileHandle) {
    throw new Error("Choose a sync database file first.");
  }

  const permissionGranted = await hasFileHandlePermission(fileHandle, { request: requestPermission });
  if (!permissionGranted) {
    throw new Error("Permission denied for selected database file.");
  }

  const items = await listAllDeckItems();
  await writeFileText(fileHandle, JSON.stringify(createFilePayload(items), null, 2));
  await writeMetaValues({
    [META_KEY_SYNC_FILE_NAME]: normalizeText(fileHandle.name) || fileName
  });

  return {
    fileName: normalizeText(fileHandle.name) || fileName,
    count: items.length
  };
}

export async function getDatabaseLocationInfo() {
  const meta = await readMetaValues([META_KEY_SYNC_FILE_NAME, META_KEY_MIGRATION_NOTICE]);
  const syncFileName = normalizeText(meta[META_KEY_SYNC_FILE_NAME]);
  const notice = normalizeText(meta[META_KEY_MIGRATION_NOTICE]);

  if (syncFileName) {
    return {
      summary: `Deck is stored in internal IndexedDB storage. Manual sync file: ${syncFileName}.`,
      detail: `Internal IndexedDB storage + sync file (${syncFileName})`,
      notice,
      hasSyncFile: true
    };
  }

  return {
    summary: "Deck is stored in internal IndexedDB storage. No sync file selected.",
    detail: "Internal IndexedDB storage",
    notice,
    hasSyncFile: false
  };
}

export function createDeckItem({ sourceText, translatedText, sourceLang, targetLang }) {
  return {
    id: crypto.randomUUID(),
    sourceText: normalizeText(sourceText),
    translatedText: normalizeText(translatedText),
    sourceLang: normalizeLanguageCode(sourceLang, "auto"),
    targetLang: normalizeLanguageCode(targetLang, "vi"),
    createdAt: new Date().toISOString()
  };
}

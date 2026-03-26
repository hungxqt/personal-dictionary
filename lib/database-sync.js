import { syncDatabaseToFile } from "./database.js";

export const DATABASE_LAST_SYNC_AT_KEY = "dbLastSyncAt";

function normalizeLastSyncAt(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "";
  }

  const parsedDate = new Date(normalizedValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return "";
  }

  return parsedDate.toISOString();
}

export async function runDatabaseSyncNow(options = {}) {
  const result = await syncDatabaseToFile(options);
  const syncedAt = new Date().toISOString();

  await chrome.storage.local.set({
    [DATABASE_LAST_SYNC_AT_KEY]: syncedAt
  });

  return {
    ...result,
    syncedAt
  };
}

export async function clearDatabaseLastSyncTime() {
  await chrome.storage.local.remove([DATABASE_LAST_SYNC_AT_KEY]);
}

export async function getDatabaseSyncStatus() {
  const data = await chrome.storage.local.get([DATABASE_LAST_SYNC_AT_KEY]);

  return {
    lastSyncAt: normalizeLastSyncAt(data[DATABASE_LAST_SYNC_AT_KEY])
  };
}

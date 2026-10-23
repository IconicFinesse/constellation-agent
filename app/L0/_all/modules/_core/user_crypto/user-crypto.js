import {
  buildUserCryptoLoginBootstrapKey,
  buildUserCryptoSessionCacheKey,
  createUserCryptoLocalStorageEntry,
  createProvisionedUserCryptoRecord,
  createUserCryptoSessionCacheEntry,
  decodeBase64Url,
  decryptUserCryptoBytes,
  decryptUserCryptoText,
  encryptUserCryptoBytes,
  encryptUserCryptoText,
  isUserCryptoEncryptedString,
  openUserCryptoLocalStorageEntry,
  normalizeUserCryptoLoginBootstrapEntry,
  normalizeUserCryptoSessionCacheEntry,
  rewrapUserCryptoRecord,
  USER_CRYPTO_LOCAL_STORAGE_KEY,
  USER_CRYPTO_STATUS_INVALIDATED,
  USER_CRYPTO_STATUS_MISSING,
  USER_CRYPTO_STATUS_READY
} from "/pages/res/user-crypto.js";

const state = {
  cache: null,
  initialized: false,
  initializationPromise: null,
  keyId: "",
  sessionId: "",
  status: USER_CRYPTO_STATUS_MISSING,
  username: "",
  warning: ""
};
const USER_CRYPTO_STATUS_BYPASS = "bypass";

function isSingleUserAppRuntime() {
  return Boolean(globalThis.space?.config?.get?.("SINGLE_USER_APP", false));
}

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  if (
    !runtime.api ||
    typeof runtime.api.userSelfInfo !== "function" ||
    typeof runtime.api.call !== "function"
  ) {
    throw new Error("space.api userSelfInfo() and call() are required for user crypto.");
  }

  return runtime;
}

function getStorageArea(storageName) {
  const storageArea = globalThis[storageName];
  return storageArea && typeof storageArea.getItem === "function" && typeof storageArea.setItem === "function"
    ? storageArea
    : null;
}

function warnOnce(message) {
  const normalizedMessage = String(message || "").trim();

  if (!normalizedMessage || state.warning === normalizedMessage) {
    return;
  }

  state.warning = normalizedMessage;
  console.warn(normalizedMessage);
}

function logUserCryptoWarning(message, error, details) {
  const normalizedMessage = String(message || "").trim();

  if (!normalizedMessage) {
    return;
  }

  if (details !== undefined) {
    console.warn(`[userCrypto] ${normalizedMessage}`, details, error);
    return;
  }

  console.warn(`[userCrypto] ${normalizedMessage}`, error);
}

function normalizeIdentity(identity = {}) {
  return {
    keyId: String(identity?.userCryptoKeyId || "").trim(),
    sessionId: String(identity?.sessionId || "").trim(),
    userCryptoState: String(identity?.userCryptoState || USER_CRYPTO_STATUS_MISSING).trim(),
    username: String(identity?.username || "").trim()
  };
}

function clearWarning() {
  state.warning = "";
}

function applySingleUserBypassState() {
  state.cache = null;
  state.initialized = true;
  state.keyId = "";
  state.sessionId = "";
  state.status = USER_CRYPTO_STATUS_BYPASS;
  state.username = "";
  clearWarning();
}

function applyRemoteState(identity) {
  state.cache = null;
  state.initialized = true;
  state.keyId = String(identity?.keyId || "").trim();
  state.sessionId = String(identity?.sessionId || "").trim();
  state.status = String(identity?.userCryptoState || USER_CRYPTO_STATUS_MISSING).trim();
  state.username = String(identity?.username || "").trim();
}

function applyCache(entry) {
  state.cache = entry;
  state.initialized = true;
  state.keyId = entry.keyId;
  state.sessionId = entry.sessionId;
  state.status = USER_CRYPTO_STATUS_READY;
  state.username = entry.username;
  clearWarning();
}

function readCachedSessionState(identity) {
  const cacheKey = buildUserCryptoSessionCacheKey({
    sessionId: identity.sessionId,
    username: identity.username
  });

  if (!cacheKey) {
    return null;
  }

  try {
    const storageArea = getStorageArea("sessionStorage");
    const rawValue = storageArea?.getItem(cacheKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    const cacheEntry = normalizeUserCryptoSessionCacheEntry(parsedValue);

    if (
      cacheEntry &&
      cacheEntry.username === identity.username &&
      cacheEntry.sessionId === identity.sessionId &&
      cacheEntry.keyId === identity.keyId
    ) {
      return cacheEntry;
    }
  } catch (error) {
    logUserCryptoWarning("Failed to read the sessionStorage userCrypto cache.", error);
  }

  return null;
}

function persistCachedSessionState(entry) {
  const cacheKey = buildUserCryptoSessionCacheKey(entry);

  if (!cacheKey) {
    return;
  }

  try {
    const storageArea = getStorageArea("sessionStorage");

    if (!storageArea) {
      return;
    }

    storageArea.setItem(cacheKey, JSON.stringify(entry));
  } catch (error) {
    logUserCryptoWarning("Failed to persist the sessionStorage userCrypto cache.", error);
  }
}

function clearCachedSessionState(identity = {}) {
  const cacheKey = buildUserCryptoSessionCacheKey(identity);

  if (!cacheKey) {
    return;
  }

  try {
    getStorageArea("sessionStorage")?.removeItem(cacheKey);
  } catch (error) {
    logUserCryptoWarning("Failed to clear the sessionStorage userCrypto cache.", error);
  }
}

async function readLocalStorageSessionState(sessionKey) {
  if (!String(sessionKey || "").trim()) {
    return {
      cacheEntry: null,
      exists: false
    };
  }

  try {
    const storageArea = getStorageArea("localStorage");
    const rawValue = storageArea?.getItem(USER_CRYPTO_LOCAL_STORAGE_KEY);

    if (rawValue === null || rawValue === undefined) {
      return {
        cacheEntry: null,
        exists: false
      };
    }

    return {
      cacheEntry: await openUserCryptoLocalStorageEntry({
        sessionKey,
        value: JSON.parse(rawValue)
      }),
      exists: true
    };
  } catch (error) {
    logUserCryptoWarning("Failed to read the localStorage userCrypto cache.", error);
    return {
      cacheEntry: null,
      exists: true
    };
  }
}

async function persistLocalStorageSessionState(entry, sessionKey) {
  if (!String(sessionKey || "").trim()) {
    return;
  }

  try {
    const storageArea = getStorageArea("localStorage");

    if (!storageArea) {
      return;
    }

    const storageEntry = await createUserCryptoLocalStorageEntry({
      cacheEntry: entry,
      sessionKey
    });
    storageArea.setItem(USER_CRYPTO_LOCAL_STORAGE_KEY, JSON.stringify(storageEntry));
  } catch (error) {
    logUserCryptoWarning("Failed to persist the localStorage userCrypto cache.", error);
  }
}

function clearLocalStorageSessionState() {
  try {
    getStorageArea("localStorage")?.removeItem(USER_CRYPTO_LOCAL_STORAGE_KEY);
  } catch (error) {
    logUserCryptoWarning("Failed to clear the localStorage userCrypto cache.", error);
  }
}

async function fetchUserCryptoSessionStorageKey() {
  const runtime = getRuntime();
  const response = await runtime.api.call("user_crypto_session_key", {
    method: "GET"
  });
  return String(response?.sessionKey || "").trim();
}

async function syncLocalStorageSessionState(entry) {
  try {
    const sessionKey = await fetchUserCryptoSessionStorageKey();

    if (!sessionKey) {
      return;
    }

    await persistLocalStorageSessionState(entry, sessionKey);
  } catch (error) {
    logUserCryptoWarning("Failed to sync the localStorage userCrypto cache.", error);
  }
}

function redirectToLogoutOnStaleLocalStorage() {
  clearLocalStorageSessionState();
  redirectToLogoutOnMissing();
}

function readLoginBootstrapState(identity) {
  const bootstrapKey = buildUserCryptoLoginBootstrapKey({
    sessionId: identity.sessionId,
    username: identity.username
  });

  if (!bootstrapKey) {
    return null;
  }

  try {
    const storageArea = getStorageArea("sessionStorage");
    const rawValue = storageArea?.getItem(bootstrapKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    const bootstrapEntry = normalizeUserCryptoLoginBootstrapEntry(parsedValue);

    if (
      bootstrapEntry &&
      bootstrapEntry.username === identity.username &&
      bootstrapEntry.sessionId === identity.sessionId
    ) {
      return bootstrapEntry;
    }
  } catch (error) {
    logUserCryptoWarning("Failed to read the login-bootstrap userCrypto cache.", error);
  }

  return null;
}

function clearLoginBootstrapState(identity = {}) {
  const bootstrapKey = buildUserCryptoLoginBootstrapKey(identity);

  if (!bootstrapKey) {
    return;
  }

  try {
    getStorageArea("sessionStorage")?.removeItem(bootstrapKey);
  } catch (error) {
    logUserCryptoWarning("Failed to clear the login-bootstrap userCrypto cache.", error);
  }
}

function redirectToLogoutOnMissing() {
  if (globalThis.location?.pathname === "/logout") {
    return;
  }

  globalThis.location?.assign?.("/logout");
}

export async function storeUnlockedUserCryptoSession({
  keyId,
  masterKey,
  serverShare,
  sessionId,
  username
} = {}) {
  const cacheEntry = createUserCryptoSessionCacheEntry({
    keyId,
    masterKey,
    serverShare,
    sessionId,
    username
  });

  persistCachedSessionState(cacheEntry);
  await syncLocalStorageSessionState(cacheEntry);
  clearLoginBootstrapState(cacheEntry);
  applyCache(cacheEntry);
  return getUserCryptoStatus();
}

async function bootstrapMissingUserCrypto(identity, bootstrapEntry) {
  const runtime = getRuntime();
  const bootstrapState = await runtime.api.call("user_crypto_bootstrap", {
    body: {},
    method: "POST"
  });

  if (
    String(bootstrapState?.state || "").trim() !== USER_CRYPTO_STATUS_MISSING ||
    !String(bootstrapState?.provisioningShare || "").trim()
  ) {
    return false;
  }

  const provisionedUserCrypto = await createProvisionedUserCryptoRecord({
    passwordIterations: bootstrapEntry.passwordIterations,
    passwordSalt: decodeBase64Url(bootstrapEntry.passwordSalt),
    passwordSecret: decodeBase64Url(bootstrapEntry.passwordSecret),
    serverShare: decodeBase64Url(bootstrapState.provisioningShare)
  });
  const provisionedState = await runtime.api.call("user_crypto_bootstrap", {
    body: {
      provisioningShare: bootstrapState.provisioningShare,
      record: provisionedUserCrypto.record
    },
    method: "POST"
  });

  if (String(provisionedState?.state || "").trim() !== USER_CRYPTO_STATUS_READY) {
    return false;
  }

  await storeUnlockedUserCryptoSession({
    keyId:
      String(provisionedState?.keyId || "").trim() ||
      String(provisionedUserCrypto?.record?.key_id || "").trim(),
    masterKey: provisionedUserCrypto.masterKey,
    serverShare: decodeBase64Url(provisionedState?.serverShare || ""),
    sessionId: identity.sessionId,
    username: identity.username
  });

  return true;
}

async function initializeUserCryptoInternal(options = {}) {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return getUserCryptoStatus();
  }

  const runtime = getRuntime();
  const identity = normalizeIdentity(await runtime.api.userSelfInfo());
  const bootstrapEntry =
    identity.username && identity.sessionId ? readLoginBootstrapState(identity) : null;
  const cacheEntry =
    identity.username && identity.sessionId && identity.keyId ? readCachedSessionState(identity) : null;

  if (cacheEntry) {
    clearLoginBootstrapState(identity);
    applyCache(cacheEntry);
    await syncLocalStorageSessionState(cacheEntry);
    return getUserCryptoStatus();
  }

  if (identity.userCryptoState === USER_CRYPTO_STATUS_READY) {
    try {
      const sessionKey = await fetchUserCryptoSessionStorageKey();
      const localStorageState = await readLocalStorageSessionState(sessionKey);

      if (localStorageState.cacheEntry) {
        persistCachedSessionState(localStorageState.cacheEntry);
        clearLoginBootstrapState(identity);
        applyCache(localStorageState.cacheEntry);
        return getUserCryptoStatus();
      }

      if (localStorageState.exists) {
        clearCachedSessionState(identity);
        clearLoginBootstrapState(identity);
        clearLocalStorageSessionState();
        warnOnce("userCrypto local storage is stale for this session. Signing out so it can be rebuilt cleanly.");

        if (options.logOutOnMissing !== false) {
          redirectToLogoutOnStaleLocalStorage();
        }

        return getUserCryptoStatus();
      }
    } catch (error) {
      logUserCryptoWarning("Failed to restore userCrypto from localStorage.", error);
    }
  }

  applyRemoteState(identity);

  if (identity.userCryptoState === USER_CRYPTO_STATUS_MISSING) {
    clearCachedSessionState(identity);
    clearLocalStorageSessionState();

    if (bootstrapEntry) {
      try {
        const didBootstrap = await bootstrapMissingUserCrypto(identity, bootstrapEntry);

        if (didBootstrap) {
          return getUserCryptoStatus();
        }
      } catch (error) {
        warnOnce(`userCrypto bootstrap failed for this session: ${error.message}`);
      }
    }

    warnOnce("userCrypto is missing for this account. Signing out so login can provision it cleanly.");

    if (options.logOutOnMissing !== false) {
      redirectToLogoutOnMissing();
    }

    return getUserCryptoStatus();
  }

  if (identity.userCryptoState === USER_CRYPTO_STATUS_INVALIDATED) {
    clearCachedSessionState(identity);
    clearLocalStorageSessionState();
    clearLoginBootstrapState(identity);
    warnOnce("userCrypto is invalidated for this account. Encrypted values will load as empty.");
    return getUserCryptoStatus();
  }

  warnOnce("userCrypto is locked for this browser session. Sign in again to unlock encrypted values.");
  return getUserCryptoStatus();
}

export async function initializeUserCrypto(options = {}) {
  if (!state.initializationPromise || options.force === true) {
    state.initializationPromise = initializeUserCryptoInternal(options).finally(() => {
      state.initialized = true;
    });
  }

  return state.initializationPromise;
}

function requireUnlockedSession() {
  if (state.cache) {
    return state.cache;
  }

  throw new Error("userCrypto is unavailable for the current browser session.");
}

async function ensureUnlockedSession() {
  if (state.cache) {
    return state.cache;
  }

  await initializeUserCrypto({
    logOutOnMissing: false
  });
  return requireUnlockedSession();
}

export function getUserCryptoStatus() {
  return {
    isReady: Boolean(state.cache) || state.status === USER_CRYPTO_STATUS_BYPASS,
    keyId: state.keyId,
    sessionId: state.sessionId,
    status: state.status,
    username: state.username
  };
}

export function isUserCryptoReady() {
  return Boolean(state.cache) || state.status === USER_CRYPTO_STATUS_BYPASS;
}

export function clearUserCryptoSession() {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return;
  }

  clearCachedSessionState({
    sessionId: state.sessionId,
    username: state.username
  });
  clearLocalStorageSessionState();
  clearLoginBootstrapState({
    sessionId: state.sessionId,
    username: state.username
  });
  applyRemoteState({
    keyId: "",
    sessionId: "",
    userCryptoState: USER_CRYPTO_STATUS_MISSING,
    username: state.username
  });
}

export async function buildPasswordRewrap(newPassword) {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return null;
  }

  try {
    const session = await ensureUnlockedSession();
    const nextRecord = await rewrapUserCryptoRecord({
      keyId: session.keyId,
      masterKey: decodeBase64Url(session.masterKey),
      password: String(newPassword || ""),
      serverShare: decodeBase64Url(session.serverShare)
    });

    return nextRecord.record;
  } catch (error) {
    warnOnce(`userCrypto could not build a password rewrap: ${error.message}`);
    return null;
  }
}

export async function encryptText(value) {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return String(value ?? "");
  }

  try {
    const session = await ensureUnlockedSession();
    return await encryptUserCryptoText({
      keyId: session.keyId,
      masterKey: decodeBase64Url(session.masterKey),
      text: String(value ?? "")
    });
  } catch (error) {
    warnOnce(`userCrypto could not encrypt text: ${error.message}`);
    return "";
  }
}

export async function decryptText(value) {
  const normalizedValue = String(value ?? "");

  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return normalizedValue;
  }

  if (!isUserCryptoEncryptedString(normalizedValue)) {
    return normalizedValue;
  }

  try {
    const session = await ensureUnlockedSession();
    return await decryptUserCryptoText({
      keyId: session.keyId,
      masterKey: decodeBase64Url(session.masterKey),
      value: normalizedValue
    });
  } catch (error) {
    warnOnce(`userCrypto could not decrypt text: ${error.message}`);
    return "";
  }
}

export async function encryptBytes(value) {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return value instanceof Uint8Array ? value : new Uint8Array();
  }

  try {
    const session = await ensureUnlockedSession();
    return await encryptUserCryptoBytes({
      bytes: value,
      keyId: session.keyId,
      masterKey: decodeBase64Url(session.masterKey)
    });
  } catch (error) {
    warnOnce(`userCrypto could not encrypt bytes: ${error.message}`);
    return "";
  }
}

export async function decryptBytes(value) {
  if (isSingleUserAppRuntime()) {
    applySingleUserBypassState();
    return value instanceof Uint8Array ? value : new Uint8Array();
  }

  if (!isUserCryptoEncryptedString(value)) {
    return value instanceof Uint8Array ? value : new Uint8Array();
  }

  try {
    const session = await ensureUnlockedSession();
    return await decryptUserCryptoBytes({
      keyId: session.keyId,
      masterKey: decodeBase64Url(session.masterKey),
      value
    });
  } catch (error) {
    warnOnce(`userCrypto could not decrypt bytes: ${error.message}`);
    return new Uint8Array();
  }
}

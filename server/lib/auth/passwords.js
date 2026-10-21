import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const PASSWORD_SCHEME = "scram-sha-256";
const PASSWORD_HASH = "sha256";
const PASSWORD_ITERATIONS = 310_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_RECORD_AAD_PREFIX = "space-password-record-v1";
const PASSWORD_RECORD_STORAGE = "server-sealed-aes-256-gcm";
const PASSWORD_SEAL_ALGORITHM = "aes-256-gcm";
const PASSWORD_SEAL_IV_LENGTH = 12;
const CLIENT_KEY_LABEL = "Client Key";
const SERVER_KEY_LABEL = "Server Key";
const LOGIN_AUTH_MESSAGE_PREFIX = "space-login-v1";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function sha256(value) {
  return createHash(PASSWORD_HASH).update(value).digest();
}

function hmacSha256(key, value) {
  return createHmac(PASSWORD_HASH, key).update(value).digest();
}

function xorBuffers(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    throw new Error("Cannot xor buffers of different lengths.");
  }

  const output = Buffer.allocUnsafe(leftBuffer.length);

  for (let index = 0; index < leftBuffer.length; index += 1) {
    output[index] = leftBuffer[index] ^ rightBuffer[index];
  }

  return output;
}

function normalizeIterations(value) {
  const iterations = Number(value);
  return Number.isInteger(iterations) && iterations > 0 ? iterations : 0;
}

function normalizeKeyText(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  return decodeBase64Url(normalized).length === PASSWORD_KEY_LENGTH ? normalized : "";
}

function buildPasswordRecordAad(record = {}) {
  return Buffer.from(
    JSON.stringify({
      iterations: String(record.iterations || ""),
      prefix: PASSWORD_RECORD_AAD_PREFIX,
      salt: String(record.salt || ""),
      scheme: String(record.scheme || "")
    })
  );
}

function normalizeStoredPasswordRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const source =
    record.password && typeof record.password === "object" && !Array.isArray(record.password)
      ? record.password
      : record;
  const scheme = String(source.password_scheme || source.scheme || PASSWORD_SCHEME).trim().toLowerCase();
  const salt = String(source.password_salt || source.salt || "").trim();
  const iterations = normalizeIterations(source.password_iterations || source.iterations);
  const storage = String(source.storage || "").trim().toLowerCase();
  const ciphertext = String(source.ciphertext || "").trim();
  const iv = String(source.iv || "").trim();
  const tag = String(source.tag || "").trim();

  if (scheme !== PASSWORD_SCHEME || !salt || !iterations) {
    return null;
  }

  if (storage === PASSWORD_RECORD_STORAGE && ciphertext && iv && tag) {
    return {
      ciphertext,
      format: "sealed",
      iterations,
      iv,
      salt,
      scheme,
      storage,
      tag
    };
  }

  if (!options.allowLegacy) {
    return null;
  }

  const storedKey = normalizeKeyText(
    source.password_stored_key || source.stored_key || source.storedKey || ""
  );
  const serverKey = normalizeKeyText(
    source.password_server_key || source.server_key || source.serverKey || ""
  );

  if (!storedKey || !serverKey) {
    return null;
  }

  return {
    format: "legacy",
    iterations,
    salt,
    scheme,
    serverKey,
    storedKey
  };
}

function getPasswordSealKey(authKeys) {
  const key = authKeys?.passwordSealKey;

  if (!Buffer.isBuffer(key) || key.length !== PASSWORD_KEY_LENGTH) {
    throw new Error("Password seal key is unavailable.");
  }

  return key;
}

function deriveSaltedPassword(password, salt, iterations) {
  return pbkdf2Sync(String(password || ""), decodeBase64Url(salt), iterations, PASSWORD_KEY_LENGTH, PASSWORD_HASH);
}

function sealPasswordVerifierRecord(record, authKeys) {
  const normalizedStoredKey = normalizeKeyText(record.storedKey);
  const normalizedServerKey = normalizeKeyText(record.serverKey);
  const iv = randomBytes(PASSWORD_SEAL_IV_LENGTH);

  if (!normalizedStoredKey || !normalizedServerKey) {
    throw new Error("Password verifier fields are invalid.");
  }

  const cipher = createCipheriv(PASSWORD_SEAL_ALGORITHM, getPasswordSealKey(authKeys), iv);
  cipher.setAAD(buildPasswordRecordAad(record));

  const payload = JSON.stringify({
    server_key: normalizedServerKey,
    stored_key: normalizedStoredKey
  });
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);

  return {
    ciphertext: encodeBase64Url(ciphertext),
    iterations: String(record.iterations),
    iv: encodeBase64Url(iv),
    salt: record.salt,
    scheme: record.scheme,
    storage: PASSWORD_RECORD_STORAGE,
    tag: encodeBase64Url(cipher.getAuthTag())
  };
}

function createPasswordVerifier(password, authKeys, options = {}) {
  const iterations = normalizeIterations(options.iterations) || PASSWORD_ITERATIONS;
  const salt = options.salt ? String(options.salt) : encodeBase64Url(randomBytes(16));
  const saltedPassword = deriveSaltedPassword(password, salt, iterations);
  const clientKey = hmacSha256(saltedPassword, CLIENT_KEY_LABEL);
  const storedKey = sha256(clientKey);
  const serverKey = hmacSha256(saltedPassword, SERVER_KEY_LABEL);

  return sealPasswordVerifierRecord(
    {
      iterations,
      salt,
      scheme: PASSWORD_SCHEME,
      serverKey: encodeBase64Url(serverKey),
      storedKey: encodeBase64Url(storedKey)
    },
    authKeys
  );
}

function inspectPasswordRecord(record) {
  const normalizedRecord = normalizeStoredPasswordRecord(record, {
    allowLegacy: false
  });

  if (!normalizedRecord) {
    return null;
  }

  return {
    format: normalizedRecord.format,
    iterations: normalizedRecord.iterations,
    salt: normalizedRecord.salt,
    scheme: normalizedRecord.scheme,
    storage: normalizedRecord.storage
  };
}

function reportSealOpenFailure(options, detail) {
  if (typeof options?.onSealOpenFailure !== "function") {
    return;
  }

  try {
    options.onSealOpenFailure(detail);
  } catch {
    // Operator diagnostics must never change the login outcome.
  }
}

function openPasswordVerifierRecord(record, authKeys, options = {}) {
  const normalizedRecord = normalizeStoredPasswordRecord(record, {
    allowLegacy: false
  });

  if (!normalizedRecord || normalizedRecord.format !== "sealed") {
    return null;
  }

  let payload;

  try {
    const decipher = createDecipheriv(
      PASSWORD_SEAL_ALGORITHM,
      getPasswordSealKey(authKeys),
      decodeBase64Url(normalizedRecord.iv)
    );
    decipher.setAAD(buildPasswordRecordAad(normalizedRecord));
    decipher.setAuthTag(decodeBase64Url(normalizedRecord.tag));

    payload = Buffer.concat([
      decipher.update(decodeBase64Url(normalizedRecord.ciphertext)),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    reportSealOpenFailure(options, {
      reason: `sealed verifier failed ${PASSWORD_SEAL_ALGORITHM} authentication`,
      error
    });
    return null;
  }

  let parsedPayload;

  try {
    parsedPayload = JSON.parse(payload);
  } catch (error) {
    reportSealOpenFailure(options, {
      reason: "opened verifier payload is not valid JSON",
      error
    });
    return null;
  }

  const storedKey = normalizeKeyText(parsedPayload?.stored_key);
  const serverKey = normalizeKeyText(parsedPayload?.server_key);

  if (!storedKey || !serverKey) {
    return null;
  }

  return {
    iterations: normalizedRecord.iterations,
    salt: normalizedRecord.salt,
    scheme: normalizedRecord.scheme,
    serverKey,
    storedKey
  };
}

function migratePasswordVerifierRecord(record, authKeys) {
  const normalizedRecord = normalizeStoredPasswordRecord(record, {
    allowLegacy: true
  });

  if (!normalizedRecord) {
    return null;
  }

  if (normalizedRecord.format === "sealed") {
    const openedRecord = openPasswordVerifierRecord(record, authKeys);

    if (!openedRecord) {
      return null;
    }

    return sealPasswordVerifierRecord(openedRecord, authKeys);
  }

  return sealPasswordVerifierRecord(normalizedRecord, authKeys);
}

function buildLoginAuthMessage({ challengeToken, clientNonce, serverNonce, username }) {
  return [
    LOGIN_AUTH_MESSAGE_PREFIX,
    String(username || ""),
    String(clientNonce || ""),
    String(serverNonce || ""),
    String(challengeToken || "")
  ].join(":");
}

function verifyLoginProof(options = {}) {
  const verifier =
    options.verifier &&
    typeof options.verifier === "object" &&
    !Array.isArray(options.verifier) &&
    normalizeKeyText(options.verifier.storedKey) &&
    normalizeKeyText(options.verifier.serverKey)
      ? {
          serverKey: normalizeKeyText(options.verifier.serverKey),
          storedKey: normalizeKeyText(options.verifier.storedKey)
        }
      : null;

  if (!verifier) {
    return {
      ok: false,
      serverSignature: ""
    };
  }

  let storedKey;
  let serverKey;
  let clientProof;

  try {
    storedKey = decodeBase64Url(verifier.storedKey);
    serverKey = decodeBase64Url(verifier.serverKey);
    clientProof = decodeBase64Url(options.clientProof);
  } catch {
    return {
      ok: false,
      serverSignature: ""
    };
  }

  if (
    storedKey.length !== PASSWORD_KEY_LENGTH ||
    serverKey.length !== PASSWORD_KEY_LENGTH ||
    clientProof.length !== PASSWORD_KEY_LENGTH
  ) {
    return {
      ok: false,
      serverSignature: ""
    };
  }

  const authMessage = buildLoginAuthMessage(options);
  const clientSignature = hmacSha256(storedKey, authMessage);
  const clientKey = xorBuffers(clientProof, clientSignature);
  const expectedStoredKey = sha256(clientKey);

  if (!timingSafeEqual(expectedStoredKey, storedKey)) {
    return {
      ok: false,
      serverSignature: ""
    };
  }

  return {
    ok: true,
    serverSignature: encodeBase64Url(hmacSha256(serverKey, authMessage))
  };
}

function verifyPassword(password, verifier = {}) {
  const normalizedVerifier =
    verifier &&
    typeof verifier === "object" &&
    !Array.isArray(verifier) &&
    normalizeKeyText(verifier.storedKey)
      ? {
          iterations: normalizeIterations(verifier.iterations),
          salt: String(verifier.salt || "").trim(),
          storedKey: normalizeKeyText(verifier.storedKey)
        }
      : null;

  if (!normalizedVerifier || !normalizedVerifier.iterations || !normalizedVerifier.salt) {
    return false;
  }

  let expectedStoredKey;
  let storedKey;

  try {
    const saltedPassword = deriveSaltedPassword(
      password,
      normalizedVerifier.salt,
      normalizedVerifier.iterations
    );
    const clientKey = hmacSha256(saltedPassword, CLIENT_KEY_LABEL);
    expectedStoredKey = sha256(clientKey);
    storedKey = decodeBase64Url(normalizedVerifier.storedKey);
  } catch {
    return false;
  }

  if (expectedStoredKey.length !== storedKey.length || storedKey.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  return timingSafeEqual(expectedStoredKey, storedKey);
}

export {
  CLIENT_KEY_LABEL,
  LOGIN_AUTH_MESSAGE_PREFIX,
  PASSWORD_HASH,
  PASSWORD_ITERATIONS,
  PASSWORD_KEY_LENGTH,
  PASSWORD_RECORD_STORAGE,
  PASSWORD_SCHEME,
  SERVER_KEY_LABEL,
  buildLoginAuthMessage,
  createPasswordVerifier,
  decodeBase64Url,
  encodeBase64Url,
  inspectPasswordRecord,
  migratePasswordVerifierRecord,
  openPasswordVerifierRecord,
  verifyLoginProof,
  verifyPassword
};

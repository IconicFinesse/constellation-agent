const REVERSE_LOOKUP = [];
const BASE64_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

for (let index = 0; index < BASE64_CODE.length; index += 1) {
  REVERSE_LOOKUP[BASE64_CODE.charCodeAt(index)] = index;
}

REVERSE_LOOKUP["-".charCodeAt(0)] = 62;
REVERSE_LOOKUP["_".charCodeAt(0)] = 63;

function getLengths(base64String) {
  const normalized = typeof base64String === "string" ? base64String : "";

  if (normalized.length % 4 > 0) {
    throw new Error("Invalid string. Length must be a multiple of 4.");
  }

  const validLength = normalized.indexOf("=") === -1 ? normalized.length : normalized.indexOf("=");
  const placeholderLength = validLength === normalized.length ? 0 : 4 - (validLength % 4);

  return [validLength, placeholderLength];
}

function getByteLength(_base64String, validLength, placeholderLength) {
  return ((validLength + placeholderLength) * 3) / 4 - placeholderLength;
}

export function toByteArray(base64String) {
  const normalized = typeof base64String === "string" ? base64String : "";
  const [validLength, placeholderLength] = getLengths(normalized);
  const bytes = new Uint8Array(getByteLength(normalized, validLength, placeholderLength));

  let chunk = 0;
  let byteIndex = 0;
  const stop = placeholderLength > 0 ? validLength - 4 : validLength;
  let index = 0;

  for (; index < stop; index += 4) {
    chunk =
      (REVERSE_LOOKUP[normalized.charCodeAt(index)] << 18) |
      (REVERSE_LOOKUP[normalized.charCodeAt(index + 1)] << 12) |
      (REVERSE_LOOKUP[normalized.charCodeAt(index + 2)] << 6) |
      REVERSE_LOOKUP[normalized.charCodeAt(index + 3)];

    bytes[byteIndex] = (chunk >> 16) & 0xff;
    bytes[byteIndex + 1] = (chunk >> 8) & 0xff;
    bytes[byteIndex + 2] = chunk & 0xff;
    byteIndex += 3;
  }

  if (placeholderLength === 2) {
    chunk =
      (REVERSE_LOOKUP[normalized.charCodeAt(index)] << 2) |
      (REVERSE_LOOKUP[normalized.charCodeAt(index + 1)] >> 4);
    bytes[byteIndex] = chunk & 0xff;
    return bytes;
  }

  if (placeholderLength === 1) {
    chunk =
      (REVERSE_LOOKUP[normalized.charCodeAt(index)] << 10) |
      (REVERSE_LOOKUP[normalized.charCodeAt(index + 1)] << 4) |
      (REVERSE_LOOKUP[normalized.charCodeAt(index + 2)] >> 2);
    bytes[byteIndex] = (chunk >> 8) & 0xff;
    bytes[byteIndex + 1] = chunk & 0xff;
  }

  return bytes;
}

const base64 = {
  toByteArray
};

export default base64;

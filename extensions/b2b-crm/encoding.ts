/**
 * Detects the character encoding of a buffer using BOM detection and byte analysis.
 * Supports: UTF-8, UTF-16LE, UTF-16BE, Windows-1252, ISO-8859-1.
 */
export function detectEncoding(buffer: Buffer): string {
  if (buffer.length === 0) return 'utf-8';

  // BOM detection — must check before content analysis
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le';
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf-16be';
  }

  // Scan bytes to distinguish UTF-8 from single-byte encodings
  let isValidUTF8 = true;
  let hasHighBytes = false;
  let hasWindows1252Bytes = false;
  let i = 0;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte < 0x80) {
      // ASCII — valid in all encodings
      i++;
      continue;
    }

    hasHighBytes = true;

    // Check for Windows-1252-specific bytes (0x80–0x9F are defined in Win-1252, undefined in ISO-8859-1)
    if (byte >= 0x80 && byte <= 0x9f) {
      hasWindows1252Bytes = true;
    }

    // Try to validate as UTF-8 multi-byte sequence
    if ((byte & 0xe0) === 0xc0) {
      // 2-byte sequence
      if (i + 1 >= buffer.length || (buffer[i + 1] & 0xc0) !== 0x80) {
        isValidUTF8 = false;
        break;
      }
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      // 3-byte sequence
      if (
        i + 2 >= buffer.length ||
        (buffer[i + 1] & 0xc0) !== 0x80 ||
        (buffer[i + 2] & 0xc0) !== 0x80
      ) {
        isValidUTF8 = false;
        break;
      }
      i += 3;
    } else if ((byte & 0xf8) === 0xf0) {
      // 4-byte sequence
      if (
        i + 3 >= buffer.length ||
        (buffer[i + 1] & 0xc0) !== 0x80 ||
        (buffer[i + 2] & 0xc0) !== 0x80 ||
        (buffer[i + 3] & 0xc0) !== 0x80
      ) {
        isValidUTF8 = false;
        break;
      }
      i += 4;
    } else {
      // Invalid UTF-8 start byte
      isValidUTF8 = false;
      break;
    }
  }

  if (!hasHighBytes) return 'utf-8'; // Pure ASCII

  if (isValidUTF8) return 'utf-8';

  // High bytes present but not valid UTF-8 — single-byte encoding
  if (hasWindows1252Bytes) return 'windows-1252';
  return 'iso-8859-1';
}

/**
 * Converts a buffer of any detected encoding to a UTF-8 string.
 * Strips BOM if present. Falls back to latin1 if UTF-8 detection is ambiguous.
 */
export function normalizeToUTF8(buffer: Buffer): string {
  const encoding = detectEncoding(buffer);

  switch (encoding) {
    case 'utf-16le': {
      // Strip 2-byte BOM if present
      const start = buffer[0] === 0xff && buffer[1] === 0xfe ? 2 : 0;
      return buffer.slice(start).toString('utf16le');
    }
    case 'utf-16be': {
      // Node.js doesn't natively support UTF-16BE decoding via Buffer.toString,
      // so we swap byte pairs then decode as utf16le
      const start = buffer[0] === 0xfe && buffer[1] === 0xff ? 2 : 0;
      const swapped = Buffer.allocUnsafe(buffer.length - start);
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        swapped[i] = buffer[start + i + 1];
        swapped[i + 1] = buffer[start + i];
      }
      return swapped.toString('utf16le');
    }
    case 'utf-8': {
      // Strip UTF-8 BOM if present
      const start =
        buffer.length >= 3 &&
        buffer[0] === 0xef &&
        buffer[1] === 0xbb &&
        buffer[2] === 0xbf
          ? 3
          : 0;
      return buffer.slice(start).toString('utf8');
    }
    case 'windows-1252':
    case 'iso-8859-1':
    default:
      // Node.js 'latin1' encoding covers both ISO-8859-1 and Windows-1252 low bytes
      return buffer.toString('latin1');
  }
}

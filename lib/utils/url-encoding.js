/**
 * URL Encoding for File Hosting System
 *
 * IMPORTANT: This module exists because JavaScript's built-in encodeURIComponent()
 * does NOT encode parentheses () per RFC 3986 (they are "unreserved" characters).
 * However, Express.js route parsing has known issues with unencoded parentheses
 * in URL paths, and shell tools like curl on Windows/PowerShell also have problems
 * with them.
 *
 * References:
 * - RFC 3986: URI Generic Syntax
 * - RFC 6266: Content-Disposition Header
 * - RFC 5987: Character Set and Language Encoding for HTTP Header Field Parameters
 *
 * @module lib/utils/url-encoding
 * @see {@link https://datatracker.ietf.org/doc/html/rfc3986}
 */

/**
 * Encodes a filename for safe use in URLs.
 *
 * Note: encodeURIComponent() does NOT encode parentheses () by default
 * per RFC 3986 (they are "unreserved" characters). However, Express.js
 * routing can have issues parsing URLs with unencoded parentheses,
 * and shell tools like curl on Windows/PowerShell also have problems
 * with them.
 *
 * @param {string} filename - The filename to encode
 * @returns {string} - URL-safe encoded filename
 *
 * @example
 * encodeFilenameForUrl('file(1).txt') // Returns: 'file%281%29.txt'
 * encodeFilenameForUrl('test [file].pdf') // Returns: 'test%20%5Bfile%5D.pdf'
 */
function encodeFilenameForUrl(filename) {
  if (!filename || typeof filename !== "string") {
    throw new TypeError("filename must be a non-empty string");
  }

  return encodeURIComponent(filename).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Builds a file URL path in the standard /files/:messageId/:filename format.
 *
 * @param {string|number} messageId - The Telegram message ID
 * @param {string} filename - The original filename
 * @returns {string} - Complete URL path
 *
 * @example
 * buildFileUrl(12345, 'document(1).pdf')
 * // Returns: '/files/12345/document%281%29.pdf'
 */
function buildFileUrl(messageId, filename) {
  if (!messageId) {
    throw new TypeError("messageId is required");
  }
  if (!filename || typeof filename !== "string") {
    throw new TypeError("filename must be a non-empty string");
  }

  return `/files/${messageId}/${encodeFilenameForUrl(filename)}`;
}

/**
 * Decodes a URL-encoded filename back to its original form.
 *
 * @param {string} encodedFilename - The URL-encoded filename
 * @returns {string} - Decoded filename
 *
 * @example
 * decodeFilename('file%281%29.txt') // Returns: 'file(1).txt'
 */
function decodeFilename(encodedFilename) {
  if (!encodedFilename || typeof encodedFilename !== "string") {
    throw new TypeError("encodedFilename must be a non-empty string");
  }

  return decodeURIComponent(encodedFilename);
}

/**
 * Encodes a filename for use in Content-Disposition headers.
 * Follows RFC 6266 and RFC 5987 for proper filename encoding.
 *
 * This provides both ASCII-safe fallback (for older browsers) and
 * UTF-8 encoded filename (for modern browsers).
 *
 * @param {string} filename - The original filename
 * @param {string} disposition - 'inline' or 'attachment' (default: 'attachment')
 * @returns {string} - Properly formatted Content-Disposition header value
 *
 * @example
 * encodeContentDisposition('file(1).txt')
 * // Returns: 'attachment; filename="file(1).txt"; filename*=UTF-8\'\'file%281%29.txt'
 *
 * @example
 * encodeContentDisposition('文件.pdf', 'inline')
 * // Returns: 'inline; filename="____.pdf"; filename*=UTF-8\'\'%E6%96%87%E4%BB%B6.pdf'
 */
function encodeContentDisposition(filename, disposition = "attachment") {
  if (!filename || typeof filename !== "string") {
    throw new TypeError("filename must be a non-empty string");
  }

  // Sanitize filename to prevent header injection
  // Remove ALL control characters (0x00-0x1F and 0x7F), not just newlines
  const sanitized = filename.replace(/[\x00-\x1F\x7F]/g, "");

  // ASCII-safe filename with proper escaping for quoted-string (RFC 2616)
  // Must escape backslash and quote characters to prevent header injection
  const asciiFilename = sanitized
    .replace(/[^\x20-\x7E]/g, "_") // Replace non-ASCII with underscore
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/"/g, '\\"'); // Escape quotes

  // RFC 5987 encoded filename (for modern browsers with UTF-8 support)
  const encodedFilename = encodeFilenameForUrl(sanitized);

  // Return both formats for maximum compatibility
  // Format: disposition; filename="ascii"; filename*=UTF-8''encoded
  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

module.exports = {
  encodeFilenameForUrl,
  buildFileUrl,
  decodeFilename,
  encodeContentDisposition,
};

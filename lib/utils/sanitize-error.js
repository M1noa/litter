const sanitizeError = (error) => {
  if (!error) return { name: 'Error', message: 'Unknown error' };

  const sanitizedMessage = typeof error.message === 'string'
    ? error.message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    : String(error.message || 'Unknown error');

  // Check for binary content in message
  const nonPrintableCount = (sanitizedMessage.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
  const displayMessage = nonPrintableCount > sanitizedMessage.length * 0.3
    ? `[Binary content in error message - ${sanitizedMessage.length} chars]`
    : sanitizedMessage;

  const result = {
    name: error.name || 'Error',
    message: displayMessage,
    code: error.code || undefined,
    errorMessage: error.errorMessage || undefined,
    type: error.type || undefined,
    retryable: error.retryable || undefined,
    waitSeconds: error.seconds || error.waitSeconds || undefined,
  };

  Object.keys(result).forEach(key => result[key] === undefined && delete result[key]);
  return result;
};

module.exports = sanitizeError;

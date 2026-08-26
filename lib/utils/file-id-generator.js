const crypto = require('crypto');

/**
 * Generate a random file ID (6-9 characters, case-insensitive alphanumeric)
 * Returns lowercase for consistency
 */
function generateFileId() {
	const length = crypto.randomInt(6, 10); // 6-9 characters
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  
  for (let i = 0; i < length; i++) {
		id += chars.charAt(crypto.randomInt(chars.length));
  }
  
  return id;
}

/**
 * Generate a unique file ID that doesn't exist in the database
 */
async function generateUniqueFileId(db) {
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = generateFileId();

    // db.query() returns rows array directly (PostgreSQLHandler.query)
    const rows = await db.query('SELECT id FROM files WHERE public_id = $1', [id]);

    if (!rows || rows.length === 0) {
      return id;
    }
  }

  throw new Error('Failed to generate unique file ID after 100 attempts');
}

module.exports = {
  generateFileId,
  generateUniqueFileId
};

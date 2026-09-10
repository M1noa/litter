const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const store = new AsyncLocalStorage();

function runWithId(id, fn) {
  return store.run({ requestId: id }, fn);
}

function getRequestId() {
  const s = store.getStore();
  return s ? s.requestId : null;
}

function generateId() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

module.exports = { runWithId, getRequestId, generateId };

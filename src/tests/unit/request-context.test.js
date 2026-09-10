const { runWithId, getRequestId, generateId } = require('../../../lib/utils/request-context');

describe('request-context', () => {
  it('generateId returns 8-char string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBe(8);
  });

  it('generateId returns unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId));
    expect(ids.size).toBe(100);
  });

  it('getRequestId returns null outside runWithId', () => {
    expect(getRequestId()).toBeNull();
  });

  it('getRequestId returns ID inside runWithId', () => {
    let captured;
    runWithId('test123', () => {
      captured = getRequestId();
    });
    expect(captured).toBe('test123');
  });

  it('getRequestId returns null after runWithId scope', () => {
    runWithId('scoped', () => {});
    expect(getRequestId()).toBeNull();
  });
});

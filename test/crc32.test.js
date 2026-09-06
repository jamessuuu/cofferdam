// The checksum is the only thing standing between a half-landed write and a
// value the API never produced, so it is checked against published vectors
// rather than against itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';
import { enc } from '../src/store.js';

test('published CRC-32 vectors', () => {
  assert.equal(crc32(enc('')), 0x00000000);
  assert.equal(crc32(enc('a')), 0xe8b7be43);
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(enc('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('a single flipped bit changes the checksum', () => {
  const a = enc('cofferdam');
  const b = Uint8Array.from(a);
  b[3] ^= 0x01;
  assert.notEqual(crc32(a), crc32(b));
});

test('the range arguments select a sub-slice', () => {
  const bytes = enc('xx123456789xx');
  assert.equal(crc32(bytes, 2, 11), 0xcbf43926);
});

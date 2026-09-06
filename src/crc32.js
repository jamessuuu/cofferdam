// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320).
//
// The store puts one of these on every log record and on the snapshot. It is
// the only thing standing between a half-landed write and a value the API
// never produced, which is why one of the planted fixtures removes it.

/** @type {Uint32Array} */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [from]
 * @param {number} [to]
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes, from = 0, to = bytes.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

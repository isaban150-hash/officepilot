const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rrot(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function toDigestInput(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  if (bytes instanceof Uint8Array) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes;
    }
    return bytes.slice();
  }
  return new Uint8Array(bytes);
}

/** Pure-JS SHA-256 for environments without `crypto.subtle` (e.g. HTTP on Mobile Safari). */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  let totalBytes = 0;
  let blockPointer = 0;

  const words = new Uint32Array(64);
  const block = new Uint8Array(64);

  const processBlock = (): void => {
    for (let index = 0, byteOffset = 0; index < 16; index += 1, byteOffset += 4) {
      words[index] =
        (block[byteOffset] << 24) |
        (block[byteOffset + 1] << 16) |
        (block[byteOffset + 2] << 8) |
        block[byteOffset + 3];
    }

    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rrot(words[index - 15], 7) ^ rrot(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = rrot(words[index - 2], 17) ^ rrot(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + sigma1 + ch + SHA256_K[index] + words[index]) | 0;
      const sigma0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + maj) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
    blockPointer = 0;
  };

  for (let index = 0; index < data.length; index += 1) {
    block[blockPointer] = data[index];
    blockPointer += 1;
    if (blockPointer === 64) {
      processBlock();
    }
  }
  totalBytes = data.length;

  block[blockPointer] = 0x80;
  blockPointer += 1;
  if (blockPointer === 64) {
    processBlock();
  }
  if (blockPointer + 8 > 64) {
    while (blockPointer < 64) {
      block[blockPointer] = 0;
      blockPointer += 1;
    }
    processBlock();
  }
  while (blockPointer < 58) {
    block[blockPointer] = 0;
    blockPointer += 1;
  }

  const bitLength = totalBytes * 8;
  block[blockPointer] = (bitLength / 0x10000000000) & 0xff;
  blockPointer += 1;
  block[blockPointer] = (bitLength / 0x100000000) & 0xff;
  blockPointer += 1;
  block[blockPointer] = bitLength >>> 24;
  blockPointer += 1;
  block[blockPointer] = (bitLength >>> 16) & 0xff;
  blockPointer += 1;
  block[blockPointer] = (bitLength >>> 8) & 0xff;
  blockPointer += 1;
  block[blockPointer] = bitLength & 0xff;
  processBlock();

  const digest = new Uint8Array(32);
  digest[0] = h0 >>> 24;
  digest[1] = (h0 >>> 16) & 0xff;
  digest[2] = (h0 >>> 8) & 0xff;
  digest[3] = h0 & 0xff;
  digest[4] = h1 >>> 24;
  digest[5] = (h1 >>> 16) & 0xff;
  digest[6] = (h1 >>> 8) & 0xff;
  digest[7] = h1 & 0xff;
  digest[8] = h2 >>> 24;
  digest[9] = (h2 >>> 16) & 0xff;
  digest[10] = (h2 >>> 8) & 0xff;
  digest[11] = h2 & 0xff;
  digest[12] = h3 >>> 24;
  digest[13] = (h3 >>> 16) & 0xff;
  digest[14] = (h3 >>> 8) & 0xff;
  digest[15] = h3 & 0xff;
  digest[16] = h4 >>> 24;
  digest[17] = (h4 >>> 16) & 0xff;
  digest[18] = (h4 >>> 8) & 0xff;
  digest[19] = h4 & 0xff;
  digest[20] = h5 >>> 24;
  digest[21] = (h5 >>> 16) & 0xff;
  digest[22] = (h5 >>> 8) & 0xff;
  digest[23] = h5 & 0xff;
  digest[24] = h6 >>> 24;
  digest[25] = (h6 >>> 16) & 0xff;
  digest[26] = (h6 >>> 8) & 0xff;
  digest[27] = h6 & 0xff;
  digest[28] = h7 >>> 24;
  digest[29] = (h7 >>> 16) & 0xff;
  digest[30] = (h7 >>> 8) & 0xff;
  digest[31] = h7 & 0xff;
  return digest;
}

function digestBufferFromFallback(data: Uint8Array): ArrayBuffer {
  const digest = sha256Bytes(data);
  return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
}

export function isSubtleDigestAvailable(): boolean {
  const crypto = globalThis.crypto;
  const subtle = crypto?.subtle;
  return typeof subtle?.digest === 'function';
}

export async function digestSha256(bytes: Uint8Array | ArrayBuffer): Promise<ArrayBuffer> {
  const data = toDigestInput(bytes);
  const crypto = globalThis.crypto;
  const subtle = crypto?.subtle;
  const digest = subtle?.digest;

  if (typeof digest === 'function') {
    try {
      return await digest.call(subtle, 'SHA-256', data);
    } catch {
      return digestBufferFromFallback(data);
    }
  }

  return digestBufferFromFallback(data);
}

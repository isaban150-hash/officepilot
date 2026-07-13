import { digestSha256 } from './sha256Digest';

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeBufferContentHash(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await digestSha256(bytes);
  return bufferToHex(digest);
}

export async function computeFileContentHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return computeBufferContentHash(buffer);
}

export async function computeDataUrlContentHash(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return computeBufferContentHash(bytes);
}

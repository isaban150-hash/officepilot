/**
 * Local auth stub – NOT production-grade password storage.
 * Replace with server-side bcrypt/argon2 via Supabase/Auth0/Firebase.
 */
const STUB_SALT = 'officepilot-local-auth-stub-v1';

export async function hashPasswordStub(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${STUB_SALT}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return `stub-sha256:${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

export async function verifyPasswordStub(password: string, passwordHash: string): Promise<boolean> {
  const computed = await hashPasswordStub(password);
  return computed === passwordHash;
}

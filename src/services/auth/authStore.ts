import type { AuthSession, License, UserAccount } from '../../types/auth';

let users: UserAccount[] = [];
let licenses: License[] = [];
let currentSession: AuthSession | null = null;

export function hydrateAuthStore(state: {
  users: UserAccount[];
  licenses: License[];
}): void {
  users = state.users.map((u) => ({ ...u }));
  licenses = state.licenses.map((l) => ({ ...l }));
}

export function getAuthUsersSnapshot(): UserAccount[] {
  return users.map((u) => ({ ...u }));
}

export function getAuthLicensesSnapshot(): License[] {
  return licenses.map((l) => ({ ...l }));
}

export function setAuthUsersForTests(next: UserAccount[]): void {
  users = next.map((u) => ({ ...u }));
}

export function setAuthLicensesForTests(next: License[]): void {
  licenses = next.map((l) => ({ ...l }));
}

export function findUserById(userId: string): UserAccount | undefined {
  return users.find((u) => u.id === userId);
}

export function findUserByEmail(email: string): UserAccount | undefined {
  const normalized = email.trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === normalized);
}

export function upsertUser(user: UserAccount): void {
  const index = users.findIndex((u) => u.id === user.id);
  if (index >= 0) {
    users[index] = { ...user };
  } else {
    users.push({ ...user });
  }
}

export function upsertLicense(license: License): void {
  const index = licenses.findIndex((l) => l.id === license.id);
  if (index >= 0) {
    licenses[index] = { ...license };
  } else {
    licenses.push({ ...license });
  }
}

export function findLicenseForUser(userId: string): License | undefined {
  return licenses
    .filter((l) => l.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function getAllUsersWithLicenses(): Array<{ user: UserAccount; license: License | undefined }> {
  return users.map((user) => ({
    user: { ...user },
    license: findLicenseForUser(user.id),
  }));
}

export function setCurrentSession(session: AuthSession | null): void {
  currentSession = session ? { ...session } : null;
}

export function getCurrentSession(): AuthSession | null {
  return currentSession ? { ...currentSession } : null;
}

export function resetAuthStore(): void {
  users = [];
  licenses = [];
  currentSession = null;
}

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'fc_session';
export const GUEST_COOKIE = 'fc_guest';
export const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  const target = typeof stored === 'string' && stored.startsWith('scrypt$') ? stored : DUMMY_HASH;
  const parts = target.split('$');
  if (parts.length !== 3) return false;
  const [, salt, key] = parts;
  let expected;
  try {
    expected = Buffer.from(key, 'hex');
  } catch {
    return false;
  }
  const actual = await scryptAsync(String(password || ''), salt, 64);
  if (expected.length !== actual.length) return false;
  const match = crypto.timingSafeEqual(expected, actual);
  return target === stored ? match : false;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const chunk of String(header).split(';')) {
    const idx = chunk.indexOf('=');
    if (idx < 0) continue;
    const name = chunk.slice(0, idx).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(chunk.slice(idx + 1).trim());
    } catch {
      out[name] = chunk.slice(idx + 1).trim();
    }
  }
  return out;
}

export function validEmail(email) {
  const s = String(email || '').trim();
  if (s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s);
}

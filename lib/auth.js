import crypto from 'node:crypto';

/*
 * Lifted from the Quick Start Home panel, with the pieces that only the panel
 * needed taken out. Kept as its own copy rather than imported: this app ships
 * as a separate image with no access to the panel's source tree, and the whole
 * stack's rule is zero npm dependencies.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'mealplan_session';
const SCRYPT_KEYLEN = 32;

const SESSION_SECRET =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : crypto.randomBytes(32).toString('hex');

const PASSWORD_HASH = (process.env.MEALPLAN_PASSWORD_HASH || '').trim();

export const authConfigured = () => PASSWORD_HASH.length > 0;
export const authRequired = () => authConfigured();

/**
 * A stored hash that cannot be verified, which is not the same as a wrong
 * password and must not be reported as one.
 *
 * The panel hit this for real: compose interpolates `$NAME` when it reads
 * .env, so a `scrypt$salt$hash` value arrived truncated and every password was
 * refused including the right one. Colons are used here for that reason, and
 * this check names the state if an old-style value ever turns up.
 */
export const passwordUnusable = () => {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    return scheme !== 'scrypt' || !saltHex || !hashHex;
};

export function hashPassword(password, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password) {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let derived;
    try {
        derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    } catch {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
}

/*
 * Stateless sessions: "<expiry>.<random>.<hmac>". Nothing to persist, and a
 * restart invalidates everything, which is the safe direction to fail in.
 *
 * The month-long expiry is the one real departure from the panel's twelve
 * hours. This is a phone on a home screen that someone opens to ask what is for
 * dinner; a login prompt every morning would mean nobody uses it.
 */
export function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expires}.${nonce}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return { token: `${payload}.${sig}`, expires };
}

export function validateSession(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${expires}.${nonce}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(expires) > Date.now();
}

export function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

export function sessionCookie(token, { secure }) {
    const attrs = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const isAuthenticated = (req) => validateSession(parseCookies(req.headers.cookie || '')[COOKIE_NAME]);

export { COOKIE_NAME };

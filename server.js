import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    authRequired,
    clearCookie,
    isAuthenticated,
    issueSession,
    passwordUnusable,
    sessionCookie,
    verifyPassword,
} from './lib/auth.js';
import {
    dateRange,
    ensureDataDir,
    isIsoDate,
    isoDate,
    loadMeals,
    loadPlan,
    normaliseMeal,
    randomFill,
    saveMeals,
    savePlan,
    setPlanSlot,
    shoppingList,
    SLOTS,
} from './lib/store.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ------------------------------------------------------------- http helpers --

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    // Served with the right type or the browser ignores the manifest entirely
    // and the app is silently not installable -- which for a thing whose whole
    // point is living on a home screen is the only failure that matters.
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(JSON.stringify(body));
}

const fail = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('Request body too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('Request body is not valid JSON.');
    }
}

function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    // Path traversal guard: the resolved file must stay inside PUBLIC_DIR.
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
        return fail(res, 403, 'Forbidden');
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                if (err2) return fail(res, 404, 'Not found');
                res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
                res.end(html);
            });
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        res.end(data);
    });
}

// --------------------------------------------------------------- the routes --

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

route('GET', /^\/healthz$/, async (req, res) => sendJson(res, 200, { ok: true }), { auth: false });

route(
    'GET',
    /^\/api\/session$/,
    async (req, res) =>
        sendJson(res, 200, {
            required: authRequired(),
            authenticated: !authRequired() || isAuthenticated(req),
            passwordUnusable: passwordUnusable(),
        }),
    { auth: false },
);

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authRequired()) return sendJson(res, 200, { ok: true, required: false });
        if (!verifyPassword(String(body.password ?? ''))) {
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'That password did not work.');
        }
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

route('POST', /^\/api\/logout$/, async (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() }), {
    auth: false,
});

// ------------------------------------------------------------------ meals --

route('GET', /^\/api\/meals$/, async (req, res) => sendJson(res, 200, { meals: loadMeals(), slots: SLOTS }));

route('POST', /^\/api\/meals$/, async (req, res) => {
    const { meal, errors } = normaliseMeal(await readBody(req));
    if (errors.length) return fail(res, 400, errors[0], { errors });
    const meals = loadMeals();
    meals.push(meal);
    saveMeals(meals);
    sendJson(res, 201, { meal });
});

route('PUT', /^\/api\/meals\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const meals = loadMeals();
    const idx = meals.findIndex((m) => m.id === match[1]);
    if (idx < 0) return fail(res, 404, 'That meal is not in the library any more.');
    const { meal, errors } = normaliseMeal(await readBody(req), meals[idx]);
    if (errors.length) return fail(res, 400, errors[0], { errors });
    meals[idx] = meal;
    saveMeals(meals);
    sendJson(res, 200, { meal });
});

route('DELETE', /^\/api\/meals\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const id = match[1];
    const meals = loadMeals();
    const next = meals.filter((m) => m.id !== id);
    if (next.length === meals.length) return fail(res, 404, 'That meal is not in the library any more.');
    saveMeals(next);

    /*
     * Also taken out of the plan.
     *
     * A plan entry is a meal id, so leaving them behind would render as a slot
     * that looks empty but is not -- random fill would skip it as taken, and
     * clearing it would need a tap on something invisible. Removing the meal
     * removes the references with it.
     */
    const plan = loadPlan();
    let touched = 0;
    for (const [date, day] of Object.entries(plan)) {
        for (const slot of SLOTS) {
            if (day[slot] === id) {
                setPlanSlot(plan, date, slot, null);
                touched += 1;
            }
        }
    }
    if (touched) savePlan(plan);
    sendJson(res, 200, { ok: true, removedFromPlan: touched });
});

// ------------------------------------------------------------------- plan --

/** Reads from/to off the query string, defaulting to the week around today. */
function rangeFrom(url) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (isIsoDate(from) && isIsoDate(to)) return { from, to, dates: dateRange(from, to) };
    const today = isoDate(new Date());
    return { from: today, to: today, dates: [today] };
}

route('GET', /^\/api\/plan$/, async (req, res, match, url) => {
    const { from, to, dates } = rangeFrom(url);
    const plan = loadPlan();
    const days = dates.map((date) => ({ date, slots: plan[date] ?? {} }));
    sendJson(res, 200, { from, to, days });
});

route('PUT', /^\/api\/plan$/, async (req, res) => {
    const body = await readBody(req);
    const { date, slot } = body;
    if (!isIsoDate(date)) return fail(res, 400, 'That is not a date this app understands.');
    if (!SLOTS.includes(slot)) return fail(res, 400, `That is not a meal of the day this plans (${SLOTS.join(', ')}).`);

    const mealId = body.mealId ? String(body.mealId) : null;
    if (mealId && !loadMeals().some((m) => m.id === mealId)) {
        return fail(res, 400, 'That meal is not in the library.');
    }

    const plan = loadPlan();
    setPlanSlot(plan, date, slot, mealId);
    savePlan(plan);
    sendJson(res, 200, { ok: true, date, slot, mealId });
});

route('POST', /^\/api\/plan\/random$/, async (req, res) => {
    const body = await readBody(req);
    const from = body.from;
    const to = body.to;
    if (!isIsoDate(from) || !isIsoDate(to)) return fail(res, 400, 'Pick a week first.');

    const dates = dateRange(from, to);
    if (!dates.length) return fail(res, 400, 'That range runs backwards.');

    const slots = Array.isArray(body.slots) ? body.slots.filter((s) => SLOTS.includes(s)) : ['dinner'];
    if (!slots.length) return fail(res, 400, 'Nothing to fill: no meal of the day was asked for.');

    const meals = loadMeals();
    if (!meals.length) return fail(res, 400, 'Add some meals first -- there is nothing to choose from.');

    const plan = loadPlan();
    const filled = randomFill(plan, meals, {
        dates,
        slots,
        overwrite: Boolean(body.overwrite),
        avoidRepeats: body.avoidRepeats !== false,
        // Default on, so a caller that predates the option behaves as before.
        includeWeekends: body.includeWeekends !== false,
    });
    savePlan(plan);

    // Nothing filled is a real answer, not a failure: it happens when every slot
    // asked for already has something and overwrite is off.
    sendJson(res, 200, { ok: true, filled: filled.length, days: dates.length });
});

route('DELETE', /^\/api\/plan$/, async (req, res, match, url) => {
    const { dates } = rangeFrom(url);
    const plan = loadPlan();
    let cleared = 0;
    for (const date of dates) {
        if (plan[date]) {
            cleared += Object.keys(plan[date]).length;
            delete plan[date];
        }
    }
    savePlan(plan);
    sendJson(res, 200, { ok: true, cleared });
});

// --------------------------------------------------------------- shopping --

route('GET', /^\/api\/shopping$/, async (req, res, match, url) => {
    const { from, to, dates } = rangeFrom(url);
    sendJson(res, 200, { from, to, items: shoppingList(loadPlan(), loadMeals(), dates) });
});

// ------------------------------------------------------------------ server --

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    if (match.auth && authRequired() && !isAuthenticated(req)) {
        return fail(res, 401, 'Not signed in.');
    }

    // Same-origin guard for state changes. The cookie is SameSite=Lax already;
    // this closes the gap for clients that ignore it.
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
            let sameHost = false;
            try {
                sameHost = new URL(origin).host === req.headers.host;
            } catch {
                sameHost = false;
            }
            if (!sameHost) return fail(res, 403, 'Cross-origin request refused.');
        }
    }

    try {
        await match.handler(req, res, match.pattern.exec(url.pathname), url);
    } catch (err) {
        log('request failed', url.pathname, err);
        if (!res.headersSent) fail(res, 500, err.message || 'Internal error');
    }
});

ensureDataDir();
server.listen(PORT, '0.0.0.0', () => {
    log(`Meal Plan listening on :${PORT}`);
    if (!authRequired()) log('no password set -- anyone who can reach this port can change the plan');
    if (passwordUnusable()) log('the stored password hash is malformed, so no password will be accepted');
});

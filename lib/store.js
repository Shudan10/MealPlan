import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Two JSON files in a Docker volume, not a database.
 *
 * A family's meal library is a few hundred records and a year of planning is
 * 365 small objects, so the whole dataset is read and written in one go without
 * anything noticing. SQLite would mean a native module, and the rule across
 * this stack is zero npm dependencies -- which is also what makes the data
 * recoverable with `cat` when something goes wrong.
 */

const DATA_DIR = process.env.MEALPLAN_DATA || '/data';
const MEALS_FILE = path.join(DATA_DIR, 'meals.json');
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');

/** The three slots, in the order a day happens. */
export const SLOTS = ['breakfast', 'lunch', 'dinner'];
export const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

export function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return structuredClone(fallback);
    }
}

/*
 * Written to a neighbouring temp file and renamed over the target.
 *
 * A plain writeFileSync truncates first, so a crash or a full disk midway
 * leaves a half-written file that parses as nothing and reads back as an empty
 * library. The temp file shares a directory with the target deliberately:
 * rename is only atomic within a filesystem, and /tmp is a different one.
 */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

export const loadMeals = () => readJson(MEALS_FILE, []);
export const saveMeals = (list) => writeJson(MEALS_FILE, list);

/** The plan is keyed by ISO date: { "2026-10-26": { dinner: "<meal id>" } }. */
export const loadPlan = () => readJson(PLAN_FILE, {});
export const savePlan = (plan) => writeJson(PLAN_FILE, plan);

const newId = () => `m_${crypto.randomBytes(8).toString('hex')}`;

// ------------------------------------------------------------------ meals --

const str = (v) => String(v ?? '').trim();

/** Splits a textarea into trimmed lines, dropping blank ones. */
const lines = (v) => {
    if (Array.isArray(v)) return v.map(str).filter(Boolean);
    return str(v)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
};

/**
 * Cleans one meal coming off the wire and says what is wrong with it.
 *
 * Everything except the name is optional on purpose. The library only gets
 * filled in if adding "Tacos" takes one field and three seconds; a form that
 * insists on ingredients and a method before it will save anything is a form
 * that stays empty, and a meal with just a name still plans a week perfectly
 * well. Recipes can be filled in later, from the sofa.
 */
export function normaliseMeal(input, existing = null) {
    const errors = [];

    const name = str(input.name);
    if (!name) errors.push('A meal needs a name.');
    if (name.length > 120) errors.push('That name is too long.');

    let slots = Array.isArray(input.slots) ? input.slots.filter((s) => SLOTS.includes(s)) : [];
    // A meal that suits no slot can never be planned or picked at random, which
    // reads as the app ignoring it. Dinner is the overwhelmingly common case.
    if (!slots.length) slots = ['dinner'];

    const servesRaw = input.serves;
    let serves = null;
    if (servesRaw !== '' && servesRaw != null) {
        const n = Number(servesRaw);
        if (!Number.isFinite(n) || n < 1 || n > 99) errors.push('Serves has to be a number between 1 and 99.');
        else serves = Math.round(n);
    }

    const meal = {
        id: existing?.id ?? newId(),
        name,
        slots,
        tags: (Array.isArray(input.tags) ? input.tags : str(input.tags).split(','))
            .map((t) => str(t).toLowerCase())
            .filter(Boolean)
            .slice(0, 12),
        serves,
        ingredients: lines(input.ingredients).slice(0, 100),
        method: lines(input.method).slice(0, 60),
        notes: str(input.notes).slice(0, 2000),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    return { meal, errors };
}

// ------------------------------------------------------------------- plan --

/** ISO date for a Date, in local terms rather than UTC. */
export function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

/** Every date from `from` to `to` inclusive. Caps the span so one bad request
 *  cannot ask for a decade and get a response to match. */
export function dateRange(from, to, maxDays = 120) {
    const out = [];
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out;
    for (const d = start; d <= end && out.length < maxDays; d.setDate(d.getDate() + 1)) {
        out.push(isoDate(d));
    }
    return out;
}

/** Sets or clears one slot on one day, pruning days that end up empty. */
export function setPlanSlot(plan, date, slot, mealId) {
    const day = { ...(plan[date] ?? {}) };
    if (mealId) day[slot] = mealId;
    else delete day[slot];

    // An empty day is dropped rather than stored as {}, so the file stays a
    // record of what was planned instead of every date ever looked at.
    if (Object.keys(day).length) plan[date] = day;
    else delete plan[date];
    return plan;
}

/**
 * Fills the given days and slots with random meals.
 *
 * Two rules worth stating, because both are what makes the result usable rather
 * than merely random:
 *
 * `avoidRepeats` draws without replacement from a shuffled pool, so a week does
 * not come back as the same thing four times -- which is what a naive pick per
 * slot produces surprisingly often with a small library. The pool refills when
 * it runs dry, so a library smaller than the week still works; it just repeats
 * once it has been round.
 *
 * `overwrite` off means it only fills blanks, so somebody who has already
 * decided on Friday keeps Friday.
 */
export function randomFill(plan, meals, { dates, slots, overwrite = false, avoidRepeats = true }) {
    const filled = [];

    for (const slot of slots) {
        const eligible = meals.filter((m) => m.slots.includes(slot));
        if (!eligible.length) continue;

        let pool = [];
        const draw = () => {
            if (!pool.length) {
                pool = [...eligible];
                // Fisher-Yates. Math.random is right here: this is dinner, not
                // a key, and crypto randomness would buy nothing.
                for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                }
            }
            return avoidRepeats ? pool.pop() : eligible[Math.floor(Math.random() * eligible.length)];
        };

        for (const date of dates) {
            if (!overwrite && plan[date]?.[slot]) continue;
            const meal = draw();
            if (!meal) continue;
            setPlanSlot(plan, date, slot, meal.id);
            filled.push({ date, slot, mealId: meal.id });
        }
    }

    return filled;
}

// --------------------------------------------------------- shopping list ----

/**
 * Everything the planned days need, grouped by identical ingredient line.
 *
 * No attempt is made to add quantities up. "500g mince" and "1 lb mince" are
 * not reconcilable without a unit parser and a food database, and a list that
 * quietly gets the amounts wrong is worse than one that shows both lines and
 * lets a human read them. Identical lines are counted, which is the part that
 * is unambiguous and is most of the benefit.
 */
export function shoppingList(plan, meals, dates) {
    const byId = new Map(meals.map((m) => [m.id, m]));
    const groups = new Map();

    for (const date of dates) {
        for (const slot of SLOTS) {
            const meal = byId.get(plan[date]?.[slot]);
            if (!meal) continue;
            for (const line of meal.ingredients) {
                const key = line.toLowerCase();
                const row = groups.get(key) ?? { text: line, count: 0, meals: [] };
                row.count += 1;
                if (!row.meals.includes(meal.name)) row.meals.push(meal.name);
                groups.set(key, row);
            }
        }
    }

    return [...groups.values()].sort((a, b) => a.text.localeCompare(b.text));
}

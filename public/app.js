'use strict';

const $ = (id) => document.getElementById(id);

const SLOTS = ['breakfast', 'lunch', 'dinner'];
const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

/*
 * Weeks start on Sunday.
 *
 * One line to change if the household would rather they started on Monday --
 * see weekStart below -- and nothing else in the app depends on which it is.
 */
const WEEK_STARTS_ON = 0;

const state = {
    meals: [],
    days: [],
    view: 'plan',
    weekStart: null,
    picking: null, // { date, slot } while the picker is open
    editing: null, // the meal being edited, or null for a new one
};

// ------------------------------------------------------------------ api ----

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* an empty body is fine */
    }
    if (res.status === 401) {
        // The session ran out while the app was open. Showing the gate again is
        // more honest than an error on every subsequent tap.
        showGate();
        throw new Error(data.error || 'Not signed in.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

let toastTimer = null;
function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// --------------------------------------------------------------- dates -----

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => new Date(`${s}T00:00:00`);

/** The start of the week containing `d`. */
function weekStart(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    out.setDate(out.getDate() - ((out.getDay() - WEEK_STARTS_ON + 7) % 7));
    return out;
}

function weekDates(start) {
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return isoDate(d);
    });
}

const fmtDayName = (iso) => parseIso(iso).toLocaleDateString(undefined, { weekday: 'long' });
const fmtDayShort = (iso) => parseIso(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function fmtWeekLabel(start) {
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const opts = { day: 'numeric', month: 'short' };
    const sameMonth = start.getMonth() === end.getMonth();
    const a = start.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : opts);
    return `${a} – ${end.toLocaleDateString(undefined, opts)}`;
}

// ------------------------------------------------------------- confirm -----

/**
 * The app's own "are you sure", rather than the browser's confirm().
 *
 * Answered from the buttons as well as the dialog's close event: the buttons
 * cannot catch Escape or a tap on the backdrop, and `close` is dispatched as a
 * queued task, so anywhere those are not run the promise would stay pending and
 * a confirmation that never resolves is an action that silently hangs.
 */
function askConfirm({ title, body = '', confirmLabel = 'OK', danger = false }) {
    const dlg = $('confirm');
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    const x = $('confirm-x');

    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    yes.textContent = confirmLabel;
    yes.className = danger ? 'primary danger' : 'primary';

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            dlg.removeEventListener('close', onClose);
            dlg.removeEventListener('keydown', onKey);
            yes.removeEventListener('click', onYes);
            no.removeEventListener('click', onNo);
            x.removeEventListener('click', onNo);
            if (dlg.open) dlg.close();
            resolve(value);
        };
        const onYes = () => finish(true);
        const onNo = () => finish(false);
        const onKey = (e) => { if (e.key === 'Escape') finish(false); };
        const onClose = () => finish(dlg.returnValue === 'ok');

        yes.addEventListener('click', onYes);
        no.addEventListener('click', onNo);
        x.addEventListener('click', onNo);
        dlg.addEventListener('close', onClose);
        dlg.addEventListener('keydown', onKey);

        dlg.returnValue = '';
        dlg.showModal();
    });
}

// ------------------------------------------------------------- the gate ----

function showGate() {
    $('gate').hidden = false;
    $('app').hidden = true;
}

async function signIn(event) {
    event.preventDefault();
    const btn = $('gate-submit');
    const err = $('gate-error');
    err.hidden = true;
    btn.disabled = true;
    try {
        await api('/api/login', { method: 'POST', body: { password: $('gate-password').value } });
        $('gate-password').value = '';
        $('gate').hidden = true;
        $('app').hidden = false;
        await loadAll();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------- rendering -----

function setView(view) {
    state.view = view;
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('is-active', tab.dataset.view === view);
    }
    $('view-plan').hidden = view !== 'plan';
    $('view-meals').hidden = view !== 'meals';
    $('view-shop').hidden = view !== 'shop';

    // The week stepper only means something where a week does.
    const weekly = view === 'plan' || view === 'shop';
    $('weeknav').hidden = !weekly;
    $('btn-today').hidden = !weekly;
    $('view-title').textContent = view === 'meals' ? 'Meals' : view === 'shop' ? 'Shopping' : 'Plan';

    if (view === 'shop') loadShopping();
}

function mealById(id) {
    return state.meals.find((m) => m.id === id) || null;
}

function renderDays() {
    const host = $('days');
    const today = isoDate(new Date());

    if (!state.meals.length) {
        host.innerHTML =
            '<div class="empty"><strong>No meals yet</strong>' +
            'Add the things your family actually eats, then plan a week from them.</div>';
        return;
    }

    host.innerHTML = '';
    for (const day of state.days) {
        const card = document.createElement('div');
        card.className = `day${day.date === today ? ' is-today' : ''}`;

        const head = document.createElement('div');
        head.className = 'day-head';
        const name = document.createElement('span');
        name.className = 'day-name';
        name.textContent = fmtDayName(day.date);
        const date = document.createElement('span');
        date.className = 'day-date';
        date.textContent = fmtDayShort(day.date);
        head.append(name, date);
        card.append(head);

        for (const slot of SLOTS) {
            const meal = mealById(day.slots[slot]);
            const row = document.createElement('button');
            row.className = 'slot-row';
            row.dataset.date = day.date;
            row.dataset.slot = slot;

            const label = document.createElement('span');
            label.className = 'slot-label';
            label.textContent = SLOT_LABELS[slot];

            const value = document.createElement('span');
            value.className = `slot-meal${meal ? '' : ' is-empty'}`;
            value.textContent = meal ? meal.name : 'Nothing planned';

            const chev = document.createElement('span');
            chev.className = 'slot-chevron';
            chev.setAttribute('aria-hidden', 'true');
            chev.textContent = '›';

            row.append(label, value, chev);
            card.append(row);
        }
        host.append(card);
    }
}

function renderMeals() {
    const host = $('meal-list');
    const q = $('meal-search').value.trim().toLowerCase();
    const list = state.meals
        .filter((m) => !q || m.name.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));

    $('meals-count').textContent = state.meals.length
        ? `${state.meals.length} meal${state.meals.length === 1 ? '' : 's'} in the library`
        : '';

    if (!list.length) {
        host.innerHTML = state.meals.length
            ? '<div class="empty"><strong>Nothing matches</strong>Try a different word.</div>'
            : '<div class="empty"><strong>No meals yet</strong>Tap + to add the first one.</div>';
        return;
    }

    host.innerHTML = '';
    for (const meal of list) {
        const card = document.createElement('button');
        card.className = 'meal-card';
        card.dataset.meal = meal.id;

        const main = document.createElement('div');
        main.className = 'meal-main';
        const name = document.createElement('div');
        name.className = 'meal-name';
        name.textContent = meal.name;
        main.append(name);

        const bits = [];
        if (meal.serves) bits.push(`serves ${meal.serves}`);
        if (meal.ingredients.length) bits.push(`${meal.ingredients.length} ingredients`);
        if (meal.method.length) bits.push(`${meal.method.length} steps`);
        if (meal.tags.length) bits.push(meal.tags.join(', '));
        if (bits.length) {
            const sub = document.createElement('div');
            sub.className = 'meal-sub';
            sub.textContent = bits.join(' · ');
            main.append(sub);
        }

        const slots = document.createElement('span');
        slots.className = 'meal-slots';
        for (const slot of SLOTS) {
            if (!meal.slots.includes(slot)) continue;
            const pill = document.createElement('span');
            pill.className = `pill ${slot}`;
            pill.textContent = slot.slice(0, 1);
            pill.title = SLOT_LABELS[slot];
            slots.append(pill);
        }

        card.append(main, slots);
        host.append(card);
    }
}

// ------------------------------------------------------------- loading -----

async function loadMeals() {
    const { meals } = await api('/api/meals');
    state.meals = meals;
}

async function loadWeek() {
    const dates = weekDates(state.weekStart);
    const { days } = await api(`/api/plan?from=${dates[0]}&to=${dates[6]}`);
    state.days = days;
    $('week-label').textContent = fmtWeekLabel(state.weekStart);
    renderDays();
}

async function loadAll() {
    await loadMeals();
    await loadWeek();
    renderMeals();
}

async function loadShopping() {
    const dates = weekDates(state.weekStart);
    const host = $('shop-list');
    try {
        const { items } = await api(`/api/shopping?from=${dates[0]}&to=${dates[6]}`);
        $('shop-hint').textContent = items.length
            ? `For ${fmtWeekLabel(state.weekStart)}. Ticks are kept on this phone only.`
            : '';
        if (!items.length) {
            host.innerHTML =
                '<div class="empty"><strong>Nothing to buy</strong>' +
                'Plan some meals that have ingredients and they will show up here.</div>';
            return;
        }

        const ticked = readTicks();
        host.innerHTML = '';
        for (const item of items) {
            const row = document.createElement('label');
            const done = ticked.has(item.text.toLowerCase());
            row.className = `shop-item${done ? ' is-done' : ''}`;

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = done;
            box.addEventListener('change', () => {
                toggleTick(item.text, box.checked);
                row.classList.toggle('is-done', box.checked);
            });

            const text = document.createElement('span');
            text.className = 'shop-text';
            text.textContent = item.text;
            const forWhat = document.createElement('span');
            forWhat.className = 'shop-for';
            forWhat.textContent = item.meals.join(', ');
            text.append(forWhat);

            row.append(box, text);
            if (item.count > 1) {
                const count = document.createElement('span');
                count.className = 'shop-count';
                count.textContent = `×${item.count}`;
                row.append(count);
            }
            host.append(row);
        }
    } catch (e) {
        toast(e.message);
    }
}

/*
 * Shopping ticks live in this browser, not on the server.
 *
 * Deliberately: whoever is standing in the shop is the only person who cares
 * which things are already in the trolley, and syncing that would mean someone
 * at home un-ticking a row halfway down an aisle. Wrapped in try/catch because
 * private mode and blocked site data both make localStorage throw rather than
 * return nothing.
 */
const tickKey = () => `mealplan.ticks.${weekDates(state.weekStart)[0]}`;

function readTicks() {
    try {
        return new Set(JSON.parse(localStorage.getItem(tickKey()) || '[]'));
    } catch {
        return new Set();
    }
}

function toggleTick(text, on) {
    try {
        const set = readTicks();
        if (on) set.add(text.toLowerCase());
        else set.delete(text.toLowerCase());
        localStorage.setItem(tickKey(), JSON.stringify([...set]));
    } catch {
        /* nothing to do: the tick stays visual for this session */
    }
}

// -------------------------------------------------------------- picker -----

function openPicker(date, slot) {
    state.picking = { date, slot };
    const current = state.days.find((d) => d.date === date)?.slots[slot] || null;
    $('picker-title').textContent = `${SLOT_LABELS[slot]} · ${fmtDayName(date)}`;
    $('picker-search').value = '';
    renderPicker(current);
    $('picker').showModal();
}

function renderPicker(current) {
    const { slot } = state.picking;
    const q = $('picker-search').value.trim().toLowerCase();
    const host = $('picker-list');

    // Meals for this slot first, then everything else -- a breakfast is rarely
    // wanted for dinner, but refusing to offer it would be wrong too.
    const eligible = state.meals.filter((m) => m.slots.includes(slot));
    const others = state.meals.filter((m) => !m.slots.includes(slot));
    const list = [...eligible, ...others].filter((m) => !q || m.name.toLowerCase().includes(q));

    if (!list.length) {
        host.innerHTML = '<p class="hint">No meals match.</p>';
        return;
    }

    host.innerHTML = '';
    for (const meal of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `picker-row${meal.id === current ? ' is-current' : ''}`;
        row.dataset.pick = meal.id;
        const name = document.createElement('span');
        name.textContent = meal.name;
        row.append(name);
        if (!meal.slots.includes(slot)) {
            const note = document.createElement('span');
            note.className = 'pill';
            note.textContent = meal.slots.map((s) => SLOT_LABELS[s]).join(' / ');
            row.append(note);
        } else if (meal.id === current) {
            const tick = document.createElement('span');
            tick.textContent = '✓';
            row.append(tick);
        }
        host.append(row);
    }
}

async function pick(mealId) {
    const { date, slot } = state.picking;
    $('picker').close();
    try {
        await api('/api/plan', { method: 'PUT', body: { date, slot, mealId } });
        await loadWeek();
    } catch (e) {
        toast(e.message);
    }
}

// -------------------------------------------------------------- editor -----

function openEditor(meal) {
    state.editing = meal;
    $('editor-title').textContent = meal ? 'Edit meal' : 'New meal';
    $('editor-error').hidden = true;
    $('ed-name').value = meal?.name ?? '';
    $('ed-serves').value = meal?.serves ?? '';
    $('ed-tags').value = (meal?.tags ?? []).join(', ');
    $('ed-ingredients').value = (meal?.ingredients ?? []).join('\n');
    $('ed-method').value = (meal?.method ?? []).join('\n');
    $('ed-notes').value = meal?.notes ?? '';
    for (const box of document.querySelectorAll('.ed-slot')) {
        box.checked = meal ? meal.slots.includes(box.value) : box.value === 'dinner';
    }
    $('ed-delete').hidden = !meal;
    $('editor').showModal();
}

async function saveMeal(event) {
    event.preventDefault();
    const err = $('editor-error');
    err.hidden = true;

    const body = {
        name: $('ed-name').value,
        slots: [...document.querySelectorAll('.ed-slot')].filter((b) => b.checked).map((b) => b.value),
        serves: $('ed-serves').value,
        tags: $('ed-tags').value,
        ingredients: $('ed-ingredients').value,
        method: $('ed-method').value,
        notes: $('ed-notes').value,
    };

    try {
        if (state.editing) await api(`/api/meals/${state.editing.id}`, { method: 'PUT', body });
        else await api('/api/meals', { method: 'POST', body });
        $('editor').close();
        await loadMeals();
        renderMeals();
        renderDays();
        toast(state.editing ? 'Saved' : 'Added');
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

async function deleteMeal() {
    const meal = state.editing;
    if (!meal) return;
    const sure = await askConfirm({
        title: `Delete ${meal.name}?`,
        body: 'It is taken out of the library and off any day it was planned for.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!sure) return;
    try {
        const { removedFromPlan } = await api(`/api/meals/${meal.id}`, { method: 'DELETE' });
        $('editor').close();
        await loadMeals();
        await loadWeek();
        renderMeals();
        toast(removedFromPlan ? `Deleted, and cleared from ${removedFromPlan} day(s)` : 'Deleted');
    } catch (e) {
        toast(e.message);
    }
}

// -------------------------------------------------------------- random -----

function openRandomer() {
    if (!state.meals.length) return toast('Add some meals first.');
    $('randomer-range').textContent = `Week of ${fmtWeekLabel(state.weekStart)}`;
    $('randomer-error').hidden = true;
    $('randomer').showModal();
}

async function runRandom(event) {
    event.preventDefault();
    const slots = [...document.querySelectorAll('.rn-slot')].filter((b) => b.checked).map((b) => b.value);
    const err = $('randomer-error');
    if (!slots.length) {
        err.textContent = 'Choose at least one of breakfast, lunch or dinner.';
        err.hidden = false;
        return;
    }
    const dates = weekDates(state.weekStart);
    try {
        const out = await api('/api/plan/random', {
            method: 'POST',
            body: {
                from: dates[0],
                to: dates[6],
                slots,
                overwrite: $('rn-overwrite').checked,
                avoidRepeats: $('rn-norepeat').checked,
            },
        });
        $('randomer').close();
        await loadWeek();
        // Nothing filled is a real outcome, not a failure, and saying so beats a
        // silent no-op: it happens when every slot asked for is already taken.
        toast(
            out.filled
                ? `Filled ${out.filled} meal${out.filled === 1 ? '' : 's'}`
                : 'Nothing to fill — those slots are already planned',
        );
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

async function clearWeek() {
    const sure = await askConfirm({
        title: 'Clear this week?',
        body: `Everything planned for ${fmtWeekLabel(state.weekStart)} is removed. Your meal library is untouched.`,
        confirmLabel: 'Clear it',
        danger: true,
    });
    if (!sure) return;
    const dates = weekDates(state.weekStart);
    try {
        const { cleared } = await api(`/api/plan?from=${dates[0]}&to=${dates[6]}`, { method: 'DELETE' });
        await loadWeek();
        toast(cleared ? `Cleared ${cleared} meal${cleared === 1 ? '' : 's'}` : 'That week was already empty');
    } catch (e) {
        toast(e.message);
    }
}

// --------------------------------------------------------------- wiring ----

function shiftWeek(days) {
    const next = new Date(state.weekStart);
    next.setDate(next.getDate() + days);
    state.weekStart = next;
    loadWeek().then(() => { if (state.view === 'shop') loadShopping(); });
}

$('gate-form').addEventListener('submit', signIn);

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
}

$('week-prev').addEventListener('click', () => shiftWeek(-7));
$('week-next').addEventListener('click', () => shiftWeek(7));
$('btn-today').addEventListener('click', () => {
    state.weekStart = weekStart(new Date());
    loadWeek().then(() => { if (state.view === 'shop') loadShopping(); });
});

// Delegated: the rows are rebuilt on every render, so listeners on them would
// have to be rebuilt too.
$('days').addEventListener('click', (e) => {
    const row = e.target.closest('.slot-row');
    if (row) openPicker(row.dataset.date, row.dataset.slot);
});

$('meal-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-meal]');
    if (card) openEditor(mealById(card.dataset.meal));
});

$('meal-search').addEventListener('input', renderMeals);
$('btn-add-meal').addEventListener('click', () => openEditor(null));

$('picker-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pick]');
    if (row) pick(row.dataset.pick);
});
$('picker-search').addEventListener('input', () => {
    const { date, slot } = state.picking;
    renderPicker(state.days.find((d) => d.date === date)?.slots[slot] || null);
});
$('picker-clear').addEventListener('click', () => pick(null));
$('picker-close').addEventListener('click', () => $('picker').close());

$('editor-form').addEventListener('submit', saveMeal);
$('editor-close').addEventListener('click', () => $('editor').close());
$('ed-delete').addEventListener('click', deleteMeal);

$('btn-random').addEventListener('click', openRandomer);
$('btn-clear').addEventListener('click', clearWeek);
$('randomer-form').addEventListener('submit', runRandom);
$('randomer-close').addEventListener('click', () => $('randomer').close());

// ----------------------------------------------------------------- boot ----

(async function boot() {
    state.weekStart = weekStart(new Date());
    try {
        const session = await fetch('/api/session').then((r) => r.json());
        if (session.passwordUnusable) {
            showGate();
            $('gate-error').textContent =
                'The stored password cannot be read, so no password will work. Whoever set this up needs to set it again.';
            $('gate-error').hidden = false;
            return;
        }
        if (!session.authenticated) return showGate();
        $('gate').hidden = true;
        $('app').hidden = false;
        await loadAll();
        setView('plan');
    } catch {
        showGate();
    }
})();

// A pass-through service worker: registered so the app is installable, and
// caching nothing, because a meal plan that shows yesterday's answer from a
// cache is worse than one that says it cannot reach the server.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

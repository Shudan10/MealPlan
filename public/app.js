'use strict';

const $ = (id) => document.getElementById(id);

// One meal of the day. Mirrors SLOTS in lib/store.js; see the note there for
// why this is still a list.
const SLOTS = ['dinner'];
const SLOT_LABELS = { dinner: 'Dinner' };

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
    monthStart: null, // the 1st of the month the calendar is showing
    // The calendar shows a month or a single week. A week shares weekStart
    // with the plan, so there is one "this week" in the app rather than two
    // that can drift apart.
    calScope: 'month',
    calDays: [], // the month grid's days, as the server has them
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

/** The 1st of the month containing `d`. */
function monthStart(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    out.setDate(1);
    return out;
}

/**
 * The days a month grid has to show: whole weeks, from the week containing the
 * 1st to the week containing the last day.
 *
 * Length is computed rather than fixed at six weeks. A 28-day February starting
 * on the first day of the week needs exactly four, and padding it to six would
 * add two rows of greyed-out days that belong to neither month.
 */
function monthGrid(first) {
    const start = weekStart(first);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const days = Math.round((weekStart(last) - start) / 86_400_000) + 7;
    return Array.from({ length: days }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return isoDate(d);
    });
}

const fmtDayName = (iso) => parseIso(iso).toLocaleDateString(undefined, { weekday: 'long' });
const fmtDayShort = (iso) => parseIso(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** What the stepper reads for a view: a month on the calendar, a week elsewhere. */
function stepperLabel(view) {
    if (view !== 'cal') return fmtWeekLabel(state.weekStart);
    return state.calScope === 'week'
        ? fmtWeekLabel(state.weekStart)
        : state.monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

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
    $('view-cal').hidden = view !== 'cal';
    $('view-meals').hidden = view !== 'meals';
    $('view-shop').hidden = view !== 'shop';

    // The stepper steps by a week on the plan and the shopping list, and by a
    // month on the calendar. Only the meal library has nothing to step through.
    const stepped = view !== 'meals';
    $('weeknav').hidden = !stepped;
    $('btn-today').hidden = !stepped;
    $('btn-today').textContent =
        view === 'cal' ? (state.calScope === 'month' ? 'Week view' : 'Month view') : 'Today';
    $('view-title').textContent =
        { plan: 'Plan', cal: 'Calendar', meals: 'Meals', shop: 'Shopping' }[view] ?? 'Plan';

    /*
     * The label is set here, not only by whichever loader runs.
     *
     * Going from the calendar to the shopping list used to leave "October 2026"
     * above a list for one week: loadShopping has no reason to touch the label,
     * so it kept whatever the calendar had put there. Deciding it from the view
     * is the only way it cannot disagree with what is on screen.
     */
    if (stepped) $('week-label').textContent = stepperLabel(view);

    if (view === 'shop') loadShopping();
    if (view === 'cal') loadCalendar().catch((e) => toast(e.message));
    // Coming back to the plan from the calendar, where a day may have been
    // changed: the week on screen could be out of date.
    if (view === 'plan') loadWeek().catch(() => {});
}

function mealById(id) {
    return state.meals.find((m) => m.id === id) || null;
}

/**
 * What is planned for a date and slot, from whichever view has that date.
 *
 * The picker can be opened from the week view or from the calendar's day sheet,
 * and those hold different ranges -- a date tapped in the calendar is usually
 * not in the loaded week at all. Asking both is what stops the picker opening
 * with nothing ticked on a day that clearly has something on it.
 */
function plannedAt(date, slot) {
    const fromWeek = state.days.find((d) => d.date === date)?.slots?.[slot];
    if (fromWeek) return fromWeek;
    return state.calDays.find((d) => d.date === date)?.slots?.[slot] ?? null;
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

            const value = document.createElement('span');
            value.className = `slot-meal${meal ? '' : ' is-empty'}`;
            value.textContent = meal ? meal.name : 'Nothing planned';

            const chev = document.createElement('span');
            chev.className = 'slot-chevron';
            chev.setAttribute('aria-hidden', 'true');
            chev.textContent = '›';

            row.append(value, chev);
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

        card.append(main);
        host.append(card);
    }
}

// ------------------------------------------------------------ calendar -----

/** One row of weekday initials, in the same order the grid runs. */
function renderWeekdays() {
    const host = $('cal-weekdays');
    if (host.childElementCount) return;
    const ref = weekStart(new Date());
    host.innerHTML = '';
    for (let i = 0; i < 7; i++) {
        const d = new Date(ref);
        d.setDate(d.getDate() + i);
        const cell = document.createElement('span');
        // Narrow rather than short: "S" twice over is no help at all, and the
        // locale decides what a sensible abbreviation looks like.
        cell.textContent = d.toLocaleDateString(undefined, { weekday: 'narrow' });
        cell.title = d.toLocaleDateString(undefined, { weekday: 'long' });
        host.append(cell);
    }
}

function renderCalendar() {
    const week = state.calScope === 'week';
    const host = $('cal-grid');
    const today = isoDate(new Date());
    const month = state.monthStart.getMonth();

    // A week names its own days inside each cell, so the strip of initials
    // above the month would just be repeating itself.
    $('cal-weekdays').hidden = week;
    if (!week) renderWeekdays();
    host.classList.toggle('is-week', week);

    host.innerHTML = '';
    for (const day of state.calDays) {
        const date = parseIso(day.date);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day';
        if (!week && date.getMonth() !== month) cell.classList.add('is-outside');
        if (day.date === today) cell.classList.add('is-today');
        cell.dataset.date = day.date;
        cell.setAttribute(
            'aria-label',
            `${parseIso(day.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`,
        );

        const num = document.createElement('span');
        num.className = 'cal-num';
        // A week has room to say which day it is in words; a month cell has
        // the column heading for that and only room for the number.
        num.textContent = week
            ? date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
            : String(date.getDate());
        cell.append(num);

        const meals = document.createElement('span');
        meals.className = 'cal-meals';
        for (const slot of SLOTS) {
            const meal = mealById(day.slots[slot]);
            if (!meal) continue;
            const row = document.createElement('span');
            row.className = 'cal-meal';
            const dot = document.createElement('span');
            dot.className = `dot ${slot}`;
            const name = document.createElement('span');
            // The slot is on the name, not only on the dot beside it, so the
            // name itself carries the colour.
            name.className = `name ${slot}`;
            name.textContent = meal.name;
            row.append(dot, name);
            row.title = `${SLOT_LABELS[slot]}: ${meal.name}`;
            meals.append(row);
        }
        if (week && !meals.childElementCount) {
            const none = document.createElement('span');
            none.className = 'cal-empty';
            none.textContent = 'Nothing planned';
            meals.append(none);
        }

        cell.append(meals);
        host.append(cell);
    }
}

async function loadCalendar() {
    const dates = state.calScope === 'week' ? weekDates(state.weekStart) : monthGrid(state.monthStart);
    const { days } = await api(`/api/plan?from=${dates[0]}&to=${dates[dates.length - 1]}`);
    state.calDays = days;
    $('week-label').textContent = stepperLabel('cal');
    renderCalendar();
}

/** The full names for one date, and a way to change any of them. */
function openDay(date) {
    const day = state.calDays.find((d) => d.date === date);
    $('day-title').textContent = parseIso(date).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });

    const host = $('day-slots');
    host.innerHTML = '';
    for (const slot of SLOTS) {
        const meal = mealById(day?.slots?.[slot]);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'day-slot';
        row.dataset.date = date;
        row.dataset.slot = slot;

        const value = document.createElement('span');
        value.className = `slot-meal${meal ? '' : ' is-empty'}`;
        value.textContent = meal ? meal.name : 'Nothing planned';
        const chev = document.createElement('span');
        chev.className = 'slot-chevron';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = '\u203a';

        row.append(value, chev);
        host.append(row);
    }
    $('day').showModal();
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
    $('week-label').textContent = stepperLabel(state.view);
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
    const current = plannedAt(date, slot);
    $('picker-title').textContent = fmtDayName(date);
    $('picker-search').value = '';
    renderPicker(current);
    $('picker').showModal();
}

function renderPicker(current) {
    const q = $('picker-search').value.trim().toLowerCase();
    const host = $('picker-list');

    // Every meal is for the one meal of the day, so there is nothing to sort
    // into eligible and the rest any more: it is the library, in order.
    const list = [...state.meals]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((m) => !q || m.name.toLowerCase().includes(q));

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
        if (meal.id === current) {
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
        // Whichever view is on screen is the one that has to be right. The other
        // reloads when it is next opened, so there is nothing to keep in step.
        if (state.view === 'cal') await loadCalendar();
        else await loadWeek();
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
    $('ed-delete').hidden = !meal;
    $('editor').showModal();
}

async function saveMeal(event) {
    event.preventDefault();
    const err = $('editor-error');
    err.hidden = true;

    const body = {
        name: $('ed-name').value,
        slots: SLOTS,
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
    const err = $('randomer-error');
    const dates = weekDates(state.weekStart);
    try {
        const out = await api('/api/plan/random', {
            method: 'POST',
            body: {
                from: dates[0],
                to: dates[6],
                slots: SLOTS,
                overwrite: $('rn-overwrite').checked,
                avoidRepeats: $('rn-norepeat').checked,
                includeWeekends: $('rn-weekends').checked,
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

/** Steps whichever period the current view is showing. */
function step(dir) {
    if (state.view === 'cal') {
        if (state.calScope === 'week') {
            const nextWeek = new Date(state.weekStart);
            nextWeek.setDate(nextWeek.getDate() + dir * 7);
            state.weekStart = nextWeek;
            loadCalendar().catch((e) => toast(e.message));
            return;
        }
        const next = new Date(state.monthStart);
        // Set the day first: stepping from the 31st into a 30-day month would
        // otherwise roll over into the one after it.
        next.setDate(1);
        next.setMonth(next.getMonth() + dir);
        state.monthStart = next;
        loadCalendar().catch((e) => toast(e.message));
        return;
    }
    const next = new Date(state.weekStart);
    next.setDate(next.getDate() + dir * 7);
    state.weekStart = next;
    loadWeek().then(() => { if (state.view === 'shop') loadShopping(); });
}

$('gate-form').addEventListener('submit', signIn);

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
}

$('week-prev').addEventListener('click', () => step(-1));
$('week-next').addEventListener('click', () => step(1));
$('btn-today').addEventListener('click', () => {
    if (state.view === 'cal') {
        // Switches between the month and a single week, and lands on the
        // current one either way -- so it doubles as the way back to today
        // after stepping off into March.
        state.calScope = state.calScope === 'month' ? 'week' : 'month';
        state.monthStart = monthStart(new Date());
        state.weekStart = weekStart(new Date());
        $('btn-today').textContent = state.calScope === 'month' ? 'Week view' : 'Month view';
        loadCalendar().catch((e) => toast(e.message));
        return;
    }
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

$('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-day');
    if (cell) openDay(cell.dataset.date);
});

// The day sheet closes before the picker opens: two stacked modals on a phone
// leave no room for either, and coming back to the sheet afterwards would show
// the value it was opened with rather than the one just chosen.
$('day-slots').addEventListener('click', (e) => {
    const row = e.target.closest('.day-slot');
    if (!row) return;
    $('day').close();
    openPicker(row.dataset.date, row.dataset.slot);
});
$('day-close').addEventListener('click', () => $('day').close());

$('meal-search').addEventListener('input', renderMeals);
$('btn-add-meal').addEventListener('click', () => openEditor(null));

$('picker-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pick]');
    if (row) pick(row.dataset.pick);
});
$('picker-search').addEventListener('input', () => {
    const { date, slot } = state.picking;
    renderPicker(plannedAt(date, slot));
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
    state.monthStart = monthStart(new Date());
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

# Meal Plan

A family meal planner for [Quick Start Home](https://github.com/Shudan10/Home). Keep
the meals your family actually eats, plan a week of dinners from them — or let
it pick at random — and get the shopping list that falls out of it.

Built to be used on a phone, standing in a kitchen.

## What it does

- **A meal library.** Name, tags, how many it serves, ingredients and method.
  Only the name is required, so adding "Tacos" takes three seconds and the
  recipe can be filled in later.
- **A week at a time.** One meal a day — dinner, which is the one that gets
  planned. Tap a day, pick a meal.
- **A month, or a week.** The calendar shows the shape of a month at a glance,
  and switches to a single week where the names are big enough to read from
  across the kitchen. The button in the header swaps between them and lands on
  the current month or week either way.
- **Random week.** Fills the days. It draws without replacement, so
  a week does not come back as the same dinner four times, and by default it
  only fills blanks — if you have already decided on Friday, Friday is kept.
  Saturday and Sunday can be left out, for households that eat differently at
  the weekend.
- **Weekly limits.** Some things should not come round twice in one week.
  Anything with `taco` in its name is capped at once a week, and the whole
  family counts as one thing: Chicken tacos, Beef tacos and Taco salad are
  different meats, but they are still tacos, and one of them on Tuesday stops
  another appearing on Friday. The rules are a short list at the top of
  `lib/store.js` (`WEEKLY_LIMITS`); adding another is one line.

## Running it

Normally this is installed and managed by the Quick Start Home panel, which
builds the image, sets the password and publishes it. To run it directly:

```bash
docker build -t mealplan .
docker run -d --name mealplan -p 8083:8080 -v mealplan-data:/data mealplan
```

Then open `http://<this machine>:8083`.

### Environment

| Variable | What it does |
| --- | --- |
| `PORT` | Port inside the container. Default `8080`. |
| `MEALPLAN_DATA` | Where the two JSON files live. Default `/data`. |
| `MEALPLAN_PASSWORD_HASH` | A `scrypt:salt:hash` value. **Without it there is no password and anyone who can reach the port can change the plan.** |
| `SESSION_SECRET` | Signs session cookies. Generated per start if unset, which logs everyone out on restart. |

Generate a password hash:

```bash
node -e "import('./lib/auth.js').then(a=>console.log(a.hashPassword('your password here')))"
```

Colons separate the fields rather than `$` on purpose: Docker Compose
interpolates `$NAME` when it reads an `.env` file, which silently truncated
`$`-separated hashes and made the panel refuse the correct password.

## Data

Two JSON files in `/data`:

- `meals.json` — the library, an array of meals.
- `plan.json` — `{ "2026-10-26": { "dinner": "<meal id>" } }`, keyed by date.

Written to a temp file and renamed over the target, so a crash midway cannot
leave a half-written file that reads back as an empty library. Both are plain
enough to fix with a text editor, which is the main reason they are not a
database.

Shopping-list ticks are *not* stored here — they live in the browser of whoever
is doing the shopping, because syncing them would mean someone at home
un-ticking a row halfway down an aisle.

## Notes

- Weeks start on Sunday. One constant at the top of `public/app.js`
  (`WEEK_STARTS_ON`) changes that, and nothing else depends on which it is.
- The service worker caches nothing. It exists so iOS treats the page as a real
  home-screen app; a meal plan served stale from a cache is worse than one that
  admits it cannot reach the server.

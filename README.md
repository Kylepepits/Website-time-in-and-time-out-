# Time Tracker — 4-hour shifts

A single-page web app for logging work shifts. Designed for 4-hour shift blocks at ₱500 per shift, 7 days a week, multiple shifts per day allowed.

## 🌐 Live website

**[https://kylepepits.github.io/Website-time-in-and-time-out-/](https://kylepepits.github.io/Website-time-in-and-time-out-/)**

Anyone with the link can open it. No install, no sign-up — runs entirely in the browser.

## How it works

The landing page has two sign-in options:

### 👷 Login as Worker
1. Click **Login as Worker**.
2. Enter your **name** + a **4-digit PIN**. Same name + same PIN on any device = same data, synced live via Firebase Firestore.
3. Click **Time In** to start a shift. Live elapsed timer + countdown to the 4-hour mark.
4. Click **Time Out** when done. If less than 4 hours elapsed the app warns the pay for that session will be ₱0.
5. Repeat as many times as you want per day, 7 days a week.
6. Click **Export to Excel** to download your personal `.xlsx` (filename includes your name + today's date).

### 🔑 Login as Admin (private dashboard)
1. Click **Login as Admin** on the landing page.
2. Enter the admin credentials (kept in the source for the project owner).
3. The dashboard shows:
   - Grand totals across all workers (workers, hours, shifts, payout).
   - One block per ISO calendar week (newest first), labelled **Week N • YYYY-Www** with the actual Monday-to-Sunday date range.
   - Per-week table: each worker's days worked (out of 7), hours, completed 4-hour shifts, salary.
   - Week totals at the bottom of every week block.
4. **Export all to Excel** generates a workbook with three sheets: *All Shifts*, *Weekly Summary*, *Per-Worker Totals*.

## Features

- **Per-user data** — only the shifts logged under your name show up in your history and your Excel export. Multiple people can use the same browser; each sees only their own data.
- **Per-user Excel** — exported file is named `time-log-<your-name>-YYYY-MM-DD.xlsx`. Two sheets:
  - **Shifts** — every clock-in / clock-out with date, day-of-week, ISO week, hours, completed 4-hour shifts, and pay.
  - **Weekly Summary** — one row per ISO week showing days worked (out of 7), total hours, completed shifts, and pay.
- **Stats dashboard** — shifts/hours/pay for today, this week (rolling 7 days), and total.
- **Local storage** — data persists in your browser across reloads. Clearing the browser's site data wipes the log.
- **Live shift timer** — countdown to the 4-hour mark, then a green confirmation when reached.

## Pay rule

```
pay per session = floor(hours_worked / 4) × ₱500
```

Examples:
- 3 h 59 m → 0 shifts → ₱0
- 4 h 30 m → 1 shift → ₱500
- 8 h 15 m → 2 shifts → ₱1,000

## Tech

Single static `index.html` — no build step, no backend. Excel export uses [SheetJS](https://sheetjs.com/) loaded from a CDN. Hosted on GitHub Pages.

## Local use

You can also save `index.html` to your computer and open it directly in any modern browser — works the same way as the hosted version, except SheetJS needs internet on first load.

## Privacy

All data lives in **your** browser's localStorage. Nothing is sent to a server. The Excel file is generated client-side and downloads to your device only.

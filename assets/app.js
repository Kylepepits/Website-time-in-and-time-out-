import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, getDoc, updateDoc, serverTimestamp, collection, getDocs, deleteField } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAJGkIssqWzMVRfrQIpQnCU8YPa8buL1WU",
  authDomain: "time-in-and-time-out.firebaseapp.com",
  projectId: "time-in-and-time-out",
  storageBucket: "time-in-and-time-out.firebasestorage.app",
  messagingSenderId: "253153967319",
  appId: "1:253153967319:web:a822595fd7c99aedf44492",
  measurementId: "G-98QH8HVRY2"
};

// NOTE: client-side admin credentials are NOT secure. Anyone viewing source can read these.
const ADMIN_USER = "admin"; // matched case-insensitively
const ADMIN_PASS = "Admin12$"; // exact match (case-sensitive)

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const HALF_HOUR_MS = 30 * 60 * 1000;
const MAX_SHIFT_MS = 24 * 60 * 60 * 1000; // hard cap: 24 hours per single shift
const PAY_PER_30MIN = 62.5; // ₱62.50 per 30 minutes = ₱125/hr

const $ = id => document.getElementById(id);
function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDuration = ms => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
};
const todayKey = () => new Date().toLocaleDateString();
const peso = n => '₱' + Math.round(n).toLocaleString();
const calcPay = hours => Math.floor(hours * 2) * PAY_PER_30MIN;
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dayName = ts => DAY_NAMES[new Date(ts).getDay()];

function isoWeek(ts) {
  const d = new Date(ts); d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getFullYear() + '-W' + String(weekNo).padStart(2,'0');
}
function weekRange(ts) {
  const d = new Date(ts); d.setHours(0,0,0,0);
  const day = d.getDay() || 7;
  const monday = new Date(d); monday.setDate(d.getDate() - (day - 1));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return [monday, sunday];
}
const fmtDate = d => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDateShort = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const sanitizeFile = s => (s || 'unnamed').replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g,'_').slice(0, 40) || 'unnamed';

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const VIEWS = ['landing', 'workerLogin', 'adminLogin', 'appCard', 'statsCard', 'historyCard', 'correctionCard', 'adminDash', 'adminPending', 'adminGrand'];
function show(...ids) {
  for (const v of VIEWS) {
    const el = $(v);
    if (!el) continue;
    if (ids.includes(v)) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }
  const aw = $('adminWeeks');
  if (ids.includes('adminDash')) aw.classList.remove('hidden');
  else { aw.classList.add('hidden'); clearChildren(aw); }
}

$('goWorker').addEventListener('click', () => { show('workerLogin'); $('name').focus(); });
$('goAdmin').addEventListener('click', () => { show('adminLogin'); $('adminUser').focus(); });
$('backFromWorker').addEventListener('click', () => show('landing'));
$('backFromAdmin').addEventListener('click', () => show('landing'));

// =========================== WORKER FLOW ===========================
let workerSession = null, entries = [], active = null, corrections = [];

const nameEl = $('name'), pinEl = $('pin');
const loginStatus = $('loginStatus');
const statusEl = $('status'), liveTimer = $('liveTimer'), shiftWarn = $('shiftWarn');
const tableWrap = $('tableWrap'), syncDot = $('syncDot'), syncText = $('syncText');
const timeInBtn = $('timeIn'), timeOutBtn = $('timeOut');

function setSync(state, text) {
  syncDot.className = 'sync-dot ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : '');
  syncText.textContent = text;
}
function setLoginStatus(msg, isError) {
  if (!msg) { loginStatus.classList.add('hidden'); return; }
  loginStatus.classList.remove('hidden');
  loginStatus.className = 'status ' + (isError ? 'error' : 'out');
  loginStatus.textContent = msg;
}

function buildWorkerTable() {
  clearChildren(tableWrap);
  if (entries.length === 0) {
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = 'No shifts logged yet.'; tableWrap.appendChild(d); return;
  }
  const headers = ['Date', 'Day', 'Time In', 'Time Out', 'Hours', 'Pay'];
  const table = document.createElement('table');
  const thead = document.createElement('thead'), trh = document.createElement('tr');
  for (const h of headers) { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); }
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const e of entries.slice().reverse()) {
    const tr = document.createElement('tr');
    const cells = [e.dateKey, dayName(e.timeIn), fmtTime(e.timeIn), fmtTime(e.timeOut), e.hours.toFixed(2), peso(calcPay(e.hours))];
    cells.forEach((val, i) => {
      const td = document.createElement('td'); td.textContent = val;
      if (i === 5) td.className = 'pay';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); tableWrap.appendChild(table);
}

function renderWorker() {
  if (active) {
    timeInBtn.disabled = true; timeOutBtn.disabled = false;
    statusEl.className = 'status in';
    statusEl.textContent = 'Clocked in since ' + fmtTime(active.timeIn) + '.';
  } else {
    timeInBtn.disabled = false; timeOutBtn.disabled = true;
    statusEl.className = 'status out';
    statusEl.textContent = 'Hello ' + (workerSession ? workerSession.name : '') + ' — ready to clock in.';
    liveTimer.textContent = ''; shiftWarn.textContent = '';
  }
  const today = todayKey();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const curYear = now.getFullYear(), curMonth = now.getMonth();
  const monthName = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const todays = entries.filter(e => e.dateKey === today);
  const weekly = entries.filter(e => e.timeIn >= sevenDaysAgo);
  const monthly = entries.filter(e => {
    const d = new Date(e.timeIn);
    return d.getFullYear() === curYear && d.getMonth() === curMonth;
  });
  const todayHours = todays.reduce((a,e) => a + e.hours, 0);
  const weekHours = weekly.reduce((a,e) => a + e.hours, 0);
  const monthHours = monthly.reduce((a,e) => a + e.hours, 0);
  const totalHours = entries.reduce((a,e) => a + e.hours, 0);
  $('todayShifts').textContent = String(todays.length);
  $('todayHours').textContent = todayHours.toFixed(2);
  $('todayPay').textContent = peso(calcPay(todayHours));
  $('weekShifts').textContent = String(weekly.length);
  $('weekPay').textContent = peso(calcPay(weekHours));
  $('monthPay').textContent = peso(calcPay(monthHours));
  $('monthLabel').textContent = 'Earnings — ' + monthName;
  $('totalShifts').textContent = String(entries.length);
  $('totalPay').textContent = peso(calcPay(totalHours));
  buildWorkerTable();
}

function tickLive() {
  const card = $('earningsCard');
  if (!active) {
    if (card) card.classList.add('hidden');
    return;
  }
  const elapsed = Date.now() - active.timeIn;
  liveTimer.textContent = 'Elapsed: ' + fmtDuration(elapsed);
  const earned = calcPay(elapsed / 3600000);
  const next30Ms = (Math.floor(elapsed / HALF_HOUR_MS) + 1) * HALF_HOUR_MS;
  const untilNext = next30Ms - elapsed;
  const totalSec = Math.floor(elapsed / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (card) card.classList.remove('hidden');
  $('earningsAmount').textContent = peso(earned);
  $('earningsMeta').textContent = h + 'h ' + m + 'm elapsed';
  $('earningsNext').textContent = fmtDuration(untilNext);
  shiftWarn.textContent = '';
}
setInterval(tickLive, 1000);

async function workerSignIn() {
  const rawName = (nameEl.value || '').trim();
  const pin = (pinEl.value || '').trim();
  if (!rawName) { setLoginStatus('Enter your name.', true); return; }
  if (!/^\d{4}$/.test(pin)) { setLoginStatus('PIN must be 4 digits.', true); return; }
  $('signin').disabled = true;
  setLoginStatus('Signing in…', false);
  try {
    const nameLower = rawName.toLowerCase();
    const nameKey = await sha256Hex(nameLower);
    const userKey = await sha256Hex(nameLower + ':' + pin);
    const claimRef = doc(db, 'names', nameKey);
    const claimSnap = await getDoc(claimRef);

    if (claimSnap.exists()) {
      const claim = claimSnap.data() || {};
      if (claim.userKey !== userKey) {
        setLoginStatus('', false);
        $('signin').disabled = false;
        alert('❌ Wrong PIN for "' + (claim.name || rawName) + '". This name is already registered with a different PIN.');
        pinEl.value = '';
        pinEl.focus();
        return;
      }
      // PIN matches the claim — proceed.
    } else {
      // First-time sign-in: also reject if a user doc already exists at this userKey
      // under a different display-cased name (defensive — shouldn't normally happen).
      try {
        await setDoc(claimRef, { name: rawName, nameLower, userKey, createdAt: serverTimestamp() });
      } catch (e) {
        console.error('Failed to create name claim:', e);
        $('signin').disabled = false;
        alert('Could not register name: ' + (e.message || e.code));
        return;
      }
    }

    // Use the canonical display name from the claim (preserves original casing of the first registrant)
    const displayName = (claimSnap.exists() && claimSnap.data().name) ? claimSnap.data().name : rawName;
    const docRef = doc(db, 'users', userKey);
    workerSession = { name: displayName, userKey, docRef, unsubscribe: null };
    sessionStorage.setItem('tt_worker', JSON.stringify({ name: rawName, pin }));
    setSync('', 'Connecting…');
    workerSession.unsubscribe = onSnapshot(docRef, (snap) => {
      const data = snap.data() || {};
      entries = Array.isArray(data.entries) ? data.entries : [];
      corrections = Array.isArray(data.corrections) ? data.corrections : [];
      active = data.active || null;
      setSync('ok', 'Synced • ' + new Date().toLocaleTimeString());
      show('appCard', 'statsCard', 'historyCard', 'correctionCard');
      renderWorker(); renderMyCorrections(); tickLive();
    }, (err) => {
      setSync('err', 'Sync error: ' + err.code); console.error(err);
    });
    const initial = await getDoc(docRef);
    if (!initial.exists()) {
      await setDoc(docRef, { name: displayName, nameLower, entries: [], active: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } else {
      const data = initial.data();
      const oldEntries = Array.isArray(data.entries) ? data.entries : [];
      let entriesNeedFix = false;
      const fixedEntries = oldEntries.map(e => {
        const newPay = calcPay(e.hours);
        if (e.pay !== newPay) { entriesNeedFix = true; return { ...e, pay: newPay }; }
        return e;
      });
      const updates = { updatedAt: serverTimestamp() };
      if (data.name !== displayName) updates.name = displayName;
      if (!data.nameLower) updates.nameLower = nameLower;
      if (entriesNeedFix) updates.entries = fixedEntries;
      if (Object.keys(updates).length > 1) {
        await updateDoc(docRef, updates);
      }
    }
    $('signin').disabled = false;
  } catch (err) {
    console.error(err);
    setSync('err', 'Failed');
    setLoginStatus('Sign-in failed: ' + (err.message || err.code || 'unknown'), true);
    $('signin').disabled = false;
  }
}

function workerSignOut() {
  if (active) { alert('Clock out first before signing out.'); return; }
  if (workerSession && workerSession.unsubscribe) workerSession.unsubscribe();
  workerSession = null; entries = []; active = null;
  sessionStorage.removeItem('tt_worker');
  pinEl.value = '';
  show('landing');
}

async function clockIn() {
  if (!workerSession || active) return;
  const today = todayKey();
  const todayHours = entries.filter(e => e.dateKey === today).reduce((a,e) => a + e.hours, 0);
  if (todayHours >= 24) {
    alert('You have already logged 24 hours today. Daily cap reached — cannot clock in again until tomorrow.');
    return;
  }
  try {
    await updateDoc(workerSession.docRef, { active: { name: workerSession.name, timeIn: Date.now() }, updatedAt: serverTimestamp() });
  } catch (err) { alert('Failed to clock in: ' + err.message); }
}
async function clockOut() {
  if (!workerSession || !active) return;
  const now = Date.now();
  let elapsed = now - active.timeIn;
  if (elapsed < HALF_HOUR_MS) {
    if (!confirm('Only ' + fmtDuration(elapsed) + ' elapsed. Less than 30 minutes — pay will be ₱0 for this session. Clock out anyway?')) return;
  }
  let timeOutMs = now;
  if (elapsed > MAX_SHIFT_MS) {
    alert('Shift exceeded 24 hours — capping at 24h. Did you forget to clock out?');
    elapsed = MAX_SHIFT_MS;
    timeOutMs = active.timeIn + MAX_SHIFT_MS;
  }
  // Per-day 24h cap (sums earlier shifts that started on the same calendar day)
  const sessionDay = new Date(active.timeIn).toLocaleDateString();
  const dayPriorHours = entries.filter(e => e.dateKey === sessionDay).reduce((a,e) => a + e.hours, 0);
  const remainingDailyMs = Math.max(0, MAX_SHIFT_MS - dayPriorHours * 3600000);
  if (elapsed > remainingDailyMs) {
    if (remainingDailyMs <= 0) {
      alert('Daily 24-hour cap already reached for ' + sessionDay + '. This session will be recorded as 0 hours / ₱0.');
      elapsed = 0;
      timeOutMs = active.timeIn;
    } else {
      alert('Daily 24h cap: prior shifts today total ' + dayPriorHours.toFixed(2) + 'h. This session capped to ' + (remainingDailyMs / 3600000).toFixed(2) + 'h.');
      elapsed = remainingDailyMs;
      timeOutMs = active.timeIn + elapsed;
    }
  }
  const hours = elapsed / 3600000;
  const pay = calcPay(hours);
  const entry = {
    name: workerSession.name,
    dateKey: new Date(active.timeIn).toLocaleDateString(),
    timeIn: active.timeIn, timeOut: timeOutMs,
    hours: +hours.toFixed(2), shifts: 1, pay,
  };
  try {
    await updateDoc(workerSession.docRef, { entries: entries.concat([entry]), active: null, updatedAt: serverTimestamp() });
  } catch (err) { alert('Failed to clock out: ' + err.message); }
}

async function clearAll() {
  if (!workerSession || active) { alert('Clock out first.'); return; }
  if (!confirm('Delete ALL of ' + workerSession.name + '\'s shifts? This cannot be undone.')) return;
  try { await updateDoc(workerSession.docRef, { entries: [], updatedAt: serverTimestamp() }); }
  catch (err) { alert('Failed: ' + err.message); }
}

function exportWorkerExcel() {
  if (!workerSession || entries.length === 0) { alert('No shifts to export.'); return; }
  const stamp = new Date().toISOString().slice(0,10);
  const data = entries.map(e => ({
    Name: e.name, Date: e.dateKey, Day: dayName(e.timeIn), Week: isoWeek(e.timeIn),
    'Time In': new Date(e.timeIn).toLocaleString(), 'Time Out': new Date(e.timeOut).toLocaleString(),
    'Hours Worked': e.hours, 'Sessions': e.shifts, 'Pay (PHP)': calcPay(e.hours),
  }));
  const totalHours = entries.reduce((a,e) => a + e.hours, 0);
  const totalShifts = Math.floor(totalHours / 4);
  data.push({});
  data.push({ Name: 'TOTAL', Date: '', Day: '', Week: '', 'Time In': '', 'Time Out': '',
    'Hours Worked': +totalHours.toFixed(2), 'Sessions': totalShifts, 'Pay (PHP)': calcPay(totalHours) });
  data.push({}); data.push({ Name: 'Exported on:', Date: stamp });
  const ws1 = XLSX.utils.json_to_sheet(data);
  ws1['!cols'] = [{wch:20},{wch:12},{wch:6},{wch:10},{wch:22},{wch:22},{wch:14},{wch:22},{wch:12}];

  const byWeek = {};
  for (const e of entries) {
    const w = isoWeek(e.timeIn);
    if (!byWeek[w]) byWeek[w] = { week: w, hours: 0, days: new Set(), sessions: 0 };
    byWeek[w].hours += e.hours; byWeek[w].days.add(e.dateKey); byWeek[w].sessions += 1;
  }
  const weekRows = Object.values(byWeek).sort((a,b) => a.week.localeCompare(b.week)).map(w => ({
    Week: w.week, 'Days Worked (out of 7)': w.days.size,
    'Total Hours': +w.hours.toFixed(2),
    'Sessions': w.sessions,
    'Pay (PHP)': calcPay(w.hours),
  }));
  const wT = weekRows.reduce((a,r) => ({ hours: a.hours + r['Total Hours'], shifts: a.shifts + r['Sessions'], pay: a.pay + r['Pay (PHP)'] }), { hours: 0, shifts: 0, pay: 0 });
  weekRows.push({});
  weekRows.push({ Week: 'TOTAL', 'Days Worked (out of 7)': '', 'Total Hours': +wT.hours.toFixed(2), 'Sessions': wT.shifts, 'Pay (PHP)': calcPay(wT.hours) });
  const ws2 = XLSX.utils.json_to_sheet(weekRows);
  ws2['!cols'] = [{wch:12},{wch:22},{wch:14},{wch:22},{wch:12}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Shifts');
  XLSX.utils.book_append_sheet(wb, ws2, 'Weekly Summary');
  XLSX.writeFile(wb, 'time-log-' + sanitizeFile(workerSession.name) + '-' + stamp + '.xlsx');
}

// ---------- Attendance correction (worker side) ----------
const corrModal = $('correctionModal');
const corrDateEl = $('corrDate');
const corrHoursEl = $('corrHours');
const corrInEl = $('corrTimeIn');
const corrOutEl = $('corrTimeOut');
const corrPayEl = $('corrPay');
const corrMetaEl = $('corrMeta');
const corrErrorEl = $('corrError');

function ymdToDate(yyyymmdd, hhmm, defaultHour) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (hhmm) {
    const [hh, mi] = hhmm.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mi, 0, 0);
  }
  return new Date(y, m - 1, d, defaultHour || 12, 0, 0, 0);
}

function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function corrCalcHours() {
  const tIn = corrInEl.value, tOut = corrOutEl.value;
  let derived = null;
  if (tIn && tOut) {
    const [hi, mi] = tIn.split(':').map(Number);
    const [ho, mo] = tOut.split(':').map(Number);
    let mins = (ho * 60 + mo) - (hi * 60 + mi);
    if (mins < 0) mins += 24 * 60; // overnight
    derived = +(mins / 60).toFixed(2);
  }
  return derived;
}

function updateCorrPay() {
  corrErrorEl.classList.add('hidden');
  // If both times set, prefill hours
  const derived = corrCalcHours();
  if (derived != null && (!corrHoursEl.value || corrHoursEl.dataset.auto === '1')) {
    corrHoursEl.value = derived;
    corrHoursEl.dataset.auto = '1';
  } else if (corrHoursEl.value && !derived) {
    corrHoursEl.dataset.auto = '0';
  }
  const h = parseFloat(corrHoursEl.value);
  if (!h || h <= 0) {
    corrPayEl.textContent = '₱0';
    corrMetaEl.textContent = 'Enter hours to see pay';
    return;
  }
  if (h > 24) {
    corrPayEl.textContent = '—';
    corrMetaEl.textContent = 'Max 24 hours per shift';
    return;
  }
  const pay = calcPay(h);
  corrPayEl.textContent = peso(pay);
  corrMetaEl.textContent = h.toFixed(2) + ' hours @ ₱125/hr (₱62.50 / 30 min)';
}

function openCorrectionModal() {
  if (!workerSession) return;
  corrDateEl.value = todayYmd();
  corrHoursEl.value = '';
  corrHoursEl.dataset.auto = '0';
  corrInEl.value = '';
  corrOutEl.value = '';
  corrErrorEl.classList.add('hidden');
  updateCorrPay();
  corrModal.classList.remove('hidden');
  corrHoursEl.focus();
}
function closeCorrectionModal() { corrModal.classList.add('hidden'); }

corrHoursEl.addEventListener('input', () => { corrHoursEl.dataset.auto = '0'; updateCorrPay(); });
corrInEl.addEventListener('input', updateCorrPay);
corrOutEl.addEventListener('input', updateCorrPay);
corrDateEl.addEventListener('input', updateCorrPay);
$('reqCorrection').addEventListener('click', openCorrectionModal);
$('corrCancel').addEventListener('click', closeCorrectionModal);
corrModal.addEventListener('click', e => { if (e.target === corrModal) closeCorrectionModal(); });

async function submitCorrection() {
  if (!workerSession) return;
  corrErrorEl.classList.add('hidden');
  const dateVal = corrDateEl.value;
  const hours = parseFloat(corrHoursEl.value);
  const tIn = corrInEl.value || null;
  const tOut = corrOutEl.value || null;
  if (!dateVal) { corrErrorEl.textContent = 'Pick a date.'; corrErrorEl.classList.remove('hidden'); return; }
  if (!hours || hours <= 0) { corrErrorEl.textContent = 'Hours must be greater than 0.'; corrErrorEl.classList.remove('hidden'); return; }
  if (hours > 24) { corrErrorEl.textContent = 'Hours must be 24 or less.'; corrErrorEl.classList.remove('hidden'); return; }

  // Build timestamps for the entry that gets created on approval
  const tInDate = tIn ? ymdToDate(dateVal, tIn) : ymdToDate(dateVal, null, 12);
  const tOutDate = tOut ? ymdToDate(dateVal, tOut) : new Date(tInDate.getTime() + hours * 3600000);

  const id = 'corr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const correction = {
    id, name: workerSession.name,
    dateKey: tInDate.toLocaleDateString(),
    hours: +hours.toFixed(2),
    timeIn: tInDate.getTime(),
    timeOut: tOutDate.getTime(),
    timeInProvided: !!tIn,
    timeOutProvided: !!tOut,
    pay: calcPay(hours),
    status: 'pending',
    submittedAt: Date.now(),
  };

  $('corrSubmit').disabled = true;
  try {
    const updated = corrections.concat([correction]);
    await updateDoc(workerSession.docRef, { corrections: updated, updatedAt: serverTimestamp() });
    closeCorrectionModal();
  } catch (err) {
    corrErrorEl.textContent = 'Submit failed: ' + (err.message || err.code);
    corrErrorEl.classList.remove('hidden');
  } finally {
    $('corrSubmit').disabled = false;
  }
}
$('corrSubmit').addEventListener('click', submitCorrection);

function renderMyCorrections() {
  const wrap = $('myCorrectionsWrap');
  clearChildren(wrap);
  if (corrections.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No correction requests yet.';
    wrap.appendChild(d);
    return;
  }
  // Group by status
  const groups = [
    { key: 'pending', label: 'Pending approval', cls: 'badge-pending' },
    { key: 'rejected', label: 'Rejected', cls: 'badge-rejected' },
    { key: 'approved', label: 'Approved (now in shift history)', cls: 'badge-approved' },
  ];
  for (const g of groups) {
    const items = corrections.filter(c => c.status === g.key);
    if (items.length === 0) continue;
    const heading = document.createElement('div');
    heading.style.cssText = 'margin-top: 14px; font-size: 13px; font-weight: 700; color: var(--muted);';
    heading.textContent = g.label + ' (' + items.length + ')';
    wrap.appendChild(heading);

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Date','Hours','Time In','Time Out','Pay','Status','Submitted'].forEach(h => {
      const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
    });
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const c of items.slice().reverse()) {
      const tr = document.createElement('tr');
      const cells = [
        c.dateKey,
        c.hours.toFixed(2),
        c.timeInProvided ? fmtTime(c.timeIn) : '—',
        c.timeOutProvided ? fmtTime(c.timeOut) : '—',
        peso(c.pay),
        '',
        new Date(c.submittedAt).toLocaleString(),
      ];
      cells.forEach((val, i) => {
        const td = document.createElement('td');
        if (i === 5) {
          const span = document.createElement('span');
          span.className = 'badge ' + g.cls;
          span.textContent = c.status;
          td.appendChild(span);
        } else {
          td.textContent = val;
          if (i === 4) td.className = 'pay';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }
}

$('signin').addEventListener('click', workerSignIn);
pinEl.addEventListener('keydown', e => { if (e.key === 'Enter') workerSignIn(); });
nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') pinEl.focus(); });
$('signout').addEventListener('click', workerSignOut);
timeInBtn.addEventListener('click', clockIn);
timeOutBtn.addEventListener('click', clockOut);
$('export').addEventListener('click', exportWorkerExcel);
$('clear').addEventListener('click', clearAll);

// =========================== ADMIN FLOW ===========================
let adminAllUsers = [];

function setAdminLoginStatus(msg, isError) {
  const el = $('adminLoginStatus');
  if (!msg) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.className = 'status ' + (isError ? 'error' : 'out');
  el.textContent = msg;
}

async function adminSignIn() {
  const u = ($('adminUser').value || '').trim();
  const p = ($('adminPass').value || '').trim();
  if (u.toLowerCase() !== ADMIN_USER.toLowerCase() || p !== ADMIN_PASS) {
    setAdminLoginStatus('Invalid manager credentials.', true);
    return;
  }
  setAdminLoginStatus('', false);
  sessionStorage.setItem('tt_admin', '1');
  await loadAdminDashboard();
}
function adminSignOut() {
  sessionStorage.removeItem('tt_admin');
  $('adminUser').value = ''; $('adminPass').value = '';
  show('landing');
}

async function loadAdminDashboard() {
  show('adminDash');
  const ls = $('adminLoadingStatus');
  ls.classList.remove('hidden');
  ls.className = 'status out'; ls.textContent = 'Loading users…';
  try {
    const snap = await getDocs(collection(db, 'users'));
    adminAllUsers = [];
    const migrationPromises = [];
    snap.forEach(s => {
      const d = s.data() || {};
      const userEntries = Array.isArray(d.entries) ? d.entries : [];
      const userCorrections = Array.isArray(d.corrections) ? d.corrections : [];
      if (userEntries.length === 0 && userCorrections.length === 0) return;
      // Migrate stored pay
      let dirty = false;
      const fixed = userEntries.map(e => {
        const newPay = calcPay(e.hours);
        if (e.pay !== newPay) { dirty = true; return { ...e, pay: newPay }; }
        return e;
      });
      if (dirty) {
        migrationPromises.push(
          updateDoc(doc(db, 'users', s.id), { entries: fixed, updatedAt: serverTimestamp() })
            .catch(err => console.error('Pay migration for ' + (d.name || s.id) + ':', err))
        );
      }
      adminAllUsers.push({
        id: s.id,
        name: d.name || '(unnamed)',
        entries: dirty ? fixed : userEntries,
        corrections: userCorrections,
      });
    });
    if (migrationPromises.length) await Promise.all(migrationPromises);
    renderAdminPending();
    ls.classList.add('hidden');
    renderAdminDashboard();
  } catch (err) {
    ls.className = 'status error';
    ls.textContent = 'Failed to load: ' + (err.message || err.code) + ' — make sure Firestore rules allow `list`.';
    console.error(err);
  }
}

function renderAdminDashboard() {
  const byWeek = {};
  let grandHours = 0;
  const userNames = new Set();
  for (const u of adminAllUsers) {
    userNames.add(u.name);
    for (const e of u.entries) {
      const wk = isoWeek(e.timeIn);
      if (!byWeek[wk]) {
        const [mon, sun] = weekRange(e.timeIn);
        byWeek[wk] = { weekKey: wk, monday: mon, sunday: sun, byUser: {} };
      }
      const bu = byWeek[wk].byUser;
      if (!bu[u.name]) bu[u.name] = { userId: u.id, hours: 0, days: new Set(), entries: [] };
      bu[u.name].hours += e.hours;
      bu[u.name].days.add(e.dateKey);
      bu[u.name].entries.push(e);
      grandHours += e.hours;
    }
  }
  let grandSessions = 0;
  for (const u of adminAllUsers) grandSessions += u.entries.length;
  const grandPay = calcPay(grandHours);

  const gs = $('adminGrandStats');
  clearChildren(gs);
  const gt = [
    { v: String(userNames.size), l: 'Total workers' },
    { v: grandHours.toFixed(2), l: 'Total hours' },
    { v: String(grandSessions), l: 'Total sessions' },
    { v: peso(grandPay), l: 'Total payout', cls: 'pay' },
  ];
  for (const s of gt) {
    const div = document.createElement('div');
    div.className = 'stat';
    const v = document.createElement('div'); v.className = 'v ' + (s.cls||''); v.textContent = s.v;
    const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
    div.appendChild(v); div.appendChild(l);
    gs.appendChild(div);
  }
  $('adminGrand').classList.remove('hidden');

  const weeksOrdered = Object.values(byWeek).sort((a,b) => b.monday - a.monday);
  const container = $('adminWeeks');
  clearChildren(container);
  if (weeksOrdered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.textContent = 'No shifts logged by anyone yet.';
    container.appendChild(empty);
    return;
  }
  let weekIndex = weeksOrdered.length;
  for (const w of weeksOrdered) {
    const block = document.createElement('div');
    block.className = 'week-block';

    const title = document.createElement('div');
    title.className = 'week-title';
    title.textContent = 'Week ' + weekIndex + ' • ' + w.weekKey;
    block.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'week-sub';
    sub.textContent = fmtDate(w.monday) + '  →  ' + fmtDate(w.sunday);
    block.appendChild(sub);

    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Worker', 'Days worked (of 7)', 'Hours', 'Sessions', 'Salary (Mon–Sun)', 'Action'].forEach((h, i) => {
      const th = document.createElement('th'); th.textContent = h;
      if (i >= 1 && i <= 4) th.className = 'num';
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    t.appendChild(thead);

    const tbody = document.createElement('tbody');
    let weekHours = 0, weekShifts = 0, weekPay = 0;
    const userRows = Object.entries(w.byUser).sort((a,b) => a[0].localeCompare(b[0]));
    for (const [name, agg] of userRows) {
      const sessions = agg.entries.length;
      const pay = calcPay(agg.hours);
      weekHours += agg.hours; weekShifts += sessions; weekPay += pay;
      const tr = document.createElement('tr');
      const cells = [
        { v: name },
        { v: agg.days.size + ' / 7', cls: 'num' },
        { v: agg.hours.toFixed(2), cls: 'num' },
        { v: String(sessions), cls: 'num' },
        { v: peso(pay), cls: 'num pay' },
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c.v;
        if (c.cls) td.className = c.cls;
        tr.appendChild(td);
      }
      // "Paid" action cell
      const actionTd = document.createElement('td');
      const paidBtn = document.createElement('button');
      paidBtn.className = 'btn-paid';
      paidBtn.type = 'button';
      paidBtn.textContent = '✓ Paid';
      paidBtn.title = 'Mark this worker as paid for this week and reset their week to zero';
      paidBtn.addEventListener('click', () => markPaidForWeek(agg.userId, name, w.weekKey, w.monday, w.sunday, pay, paidBtn));
      actionTd.appendChild(paidBtn);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    block.appendChild(t);

    const totals = document.createElement('div');
    totals.className = 'week-totals';
    totals.textContent = 'Week total: ' + weekHours.toFixed(2) + ' h • ' + weekShifts + ' sessions • ' + peso(weekPay);
    block.appendChild(totals);

    container.appendChild(block);
    weekIndex--;
  }
}

async function markPaidForWeek(userId, name, weekKey, monday, sunday, pay, btn) {
  const range = fmtDateShort(monday) + ' – ' + fmtDateShort(sunday);
  if (!confirm('Mark ' + name + ' as PAID for ' + weekKey + ' (' + range + ')?\n\nThis will DELETE their shift entries within ' + range + ' (₱' + Math.round(pay).toLocaleString() + ' paid).\nThe week resets to zero so they can start fresh.\n\nThis cannot be undone.')) return;
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    if (!snap.exists()) throw new Error('User record not found.');
    const data = snap.data() || {};
    const allEntries = Array.isArray(data.entries) ? data.entries : [];
    const startMs = monday.getTime();
    const endMs = sunday.getTime() + 24 * 60 * 60 * 1000 - 1;
    const remaining = allEntries.filter(e => !(e.timeIn >= startMs && e.timeIn <= endMs));
    // Hard delete: wipe the week's entries and remove any legacy paidLog field too.
    await updateDoc(userRef, {
      entries: remaining,
      paidLog: deleteField(),
      updatedAt: serverTimestamp(),
    });
    await loadAdminDashboard();
  } catch (err) {
    console.error(err);
    alert('Failed to mark paid: ' + (err.message || err.code));
    btn.disabled = false;
    btn.textContent = '✓ Paid';
  }
}

function renderAdminPending() {
  const wrap = $('adminPendingWrap');
  clearChildren(wrap);
  // Collect all pending across all users
  const pending = [];
  for (const u of adminAllUsers) {
    for (const c of (u.corrections || [])) {
      if (c.status === 'pending') pending.push({ user: u, correction: c });
    }
  }
  const card = $('adminPending');
  if (pending.length === 0) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  ['Worker','Date','Hours','Time In','Time Out','Pay','Submitted','Action'].forEach(h => {
    const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
  });
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const p of pending) {
    const c = p.correction;
    const tr = document.createElement('tr');
    const cells = [
      p.user.name,
      c.dateKey,
      c.hours.toFixed(2),
      c.timeInProvided ? fmtTime(c.timeIn) : '—',
      c.timeOutProvided ? fmtTime(c.timeOut) : '—',
      peso(c.pay),
      new Date(c.submittedAt).toLocaleString(),
      '',
    ];
    cells.forEach((val, i) => {
      const td = document.createElement('td');
      if (i === 7) {
        const ap = document.createElement('button');
        ap.className = 'btn-approve'; ap.textContent = '✓ Approve'; ap.type = 'button';
        ap.addEventListener('click', () => approveCorrection(p.user.id, c.id));
        const rj = document.createElement('button');
        rj.className = 'btn-reject'; rj.textContent = '✗ Reject'; rj.type = 'button';
        rj.addEventListener('click', () => rejectCorrection(p.user.id, c.id));
        td.appendChild(ap); td.appendChild(rj);
      } else {
        td.textContent = val;
        if (i === 5) td.className = 'pay';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

async function approveCorrection(userId, correctionId) {
  if (!confirm('Approve this correction? It will be added to the worker\'s shift history.')) return;
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    if (!snap.exists()) throw new Error('User record not found.');
    const data = snap.data() || {};
    const corrs = Array.isArray(data.corrections) ? data.corrections.slice() : [];
    const idx = corrs.findIndex(c => c.id === correctionId);
    if (idx === -1) throw new Error('Correction not found.');
    if (corrs[idx].status !== 'pending') throw new Error('Already decided.');
    const c = corrs[idx];
    corrs[idx] = { ...c, status: 'approved', decidedAt: Date.now() };
    const newEntries = (Array.isArray(data.entries) ? data.entries.slice() : []).concat([{
      name: c.name,
      dateKey: c.dateKey,
      timeIn: c.timeIn,
      timeOut: c.timeOut,
      hours: c.hours,
      shifts: 1,
      pay: calcPay(c.hours),
      correctionId: c.id,
    }]);
    await updateDoc(userRef, { entries: newEntries, corrections: corrs, updatedAt: serverTimestamp() });
    await loadAdminDashboard();
  } catch (err) {
    alert('Approve failed: ' + (err.message || err.code));
  }
}

async function rejectCorrection(userId, correctionId) {
  const reason = prompt('Reason for rejection (optional):') || '';
  if (reason === null) return;
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    if (!snap.exists()) throw new Error('User record not found.');
    const data = snap.data() || {};
    const corrs = Array.isArray(data.corrections) ? data.corrections.slice() : [];
    const idx = corrs.findIndex(c => c.id === correctionId);
    if (idx === -1) throw new Error('Correction not found.');
    if (corrs[idx].status !== 'pending') throw new Error('Already decided.');
    corrs[idx] = { ...corrs[idx], status: 'rejected', decidedAt: Date.now(), reason };
    await updateDoc(userRef, { corrections: corrs, updatedAt: serverTimestamp() });
    await loadAdminDashboard();
  } catch (err) {
    alert('Reject failed: ' + (err.message || err.code));
  }
}

function exportAdminExcel() {
  if (adminAllUsers.length === 0) { alert('No data to export.'); return; }
  const stamp = new Date().toISOString().slice(0,10);

  const allShifts = [];
  for (const u of adminAllUsers) {
    for (const e of u.entries) {
      allShifts.push({
        Worker: u.name, Date: e.dateKey, Day: dayName(e.timeIn), Week: isoWeek(e.timeIn),
        'Time In': new Date(e.timeIn).toLocaleString(),
        'Time Out': new Date(e.timeOut).toLocaleString(),
        'Hours': e.hours, 'Sessions': e.shifts, 'Pay (PHP)': calcPay(e.hours),
      });
    }
  }
  allShifts.sort((a,b) => a.Worker.localeCompare(b.Worker) || new Date(a['Time In']) - new Date(b['Time In']));
  const ws1 = XLSX.utils.json_to_sheet(allShifts);
  ws1['!cols'] = [{wch:24},{wch:12},{wch:6},{wch:10},{wch:22},{wch:22},{wch:10},{wch:12},{wch:12}];

  const map = {};
  for (const u of adminAllUsers) {
    for (const e of u.entries) {
      const wk = isoWeek(e.timeIn);
      if (!map[wk]) {
        const [m, s] = weekRange(e.timeIn);
        map[wk] = { weekKey: wk, monStr: fmtDateShort(m), sunStr: fmtDateShort(s), monday: m, byUser: {} };
      }
      if (!map[wk].byUser[u.name]) map[wk].byUser[u.name] = { hours: 0, days: new Set() };
      map[wk].byUser[u.name].hours += e.hours;
      map[wk].byUser[u.name].days.add(e.dateKey);
    }
  }
  const weekRows = [];
  const orderedWeeks = Object.values(map).sort((a,b) => a.monday - b.monday);
  let idx = 1;
  for (const w of orderedWeeks) {
    let weekTotalHours = 0, weekTotalShifts = 0, weekTotalPay = 0;
    for (const [name, agg] of Object.entries(w.byUser).sort((a,b) => a[0].localeCompare(b[0]))) {
      const sessions = agg.entries.length;
      const pay = calcPay(agg.hours);
      weekRows.push({
        'Week #': idx, 'ISO Week': w.weekKey, 'Period': w.monStr + ' – ' + w.sunStr,
        Worker: name, 'Days Worked': agg.days.size,
        'Hours': +agg.hours.toFixed(2), 'Sessions': sessions, 'Pay (PHP)': pay,
      });
      weekTotalHours += agg.hours; weekTotalShifts += sessions; weekTotalPay += pay;
    }
    weekRows.push({
      'Week #': idx, 'ISO Week': w.weekKey, 'Period': w.monStr + ' – ' + w.sunStr,
      Worker: '— WEEK TOTAL —', 'Days Worked': '',
      'Hours': +weekTotalHours.toFixed(2), 'Sessions': weekTotalShifts, 'Pay (PHP)': weekTotalPay,
    });
    weekRows.push({});
    idx++;
  }
  const ws2 = XLSX.utils.json_to_sheet(weekRows);
  ws2['!cols'] = [{wch:7},{wch:10},{wch:20},{wch:24},{wch:12},{wch:10},{wch:12},{wch:12}];

  const perWorker = {};
  for (const u of adminAllUsers) {
    const totalHours = u.entries.reduce((a,e) => a + e.hours, 0);
    perWorker[u.name] = { Worker: u.name, 'Total Hours': +totalHours.toFixed(2), 'Total Sessions': u.entries.length, 'Total Pay (PHP)': calcPay(totalHours) };
  }
  const summaryRows = Object.values(perWorker).sort((a,b) => a.Worker.localeCompare(b.Worker));
  const ws3 = XLSX.utils.json_to_sheet(summaryRows);
  ws3['!cols'] = [{wch:24},{wch:12},{wch:12},{wch:14}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'All Shifts');
  XLSX.utils.book_append_sheet(wb, ws2, 'Weekly Summary');
  XLSX.utils.book_append_sheet(wb, ws3, 'Per-Worker Totals');
  XLSX.writeFile(wb, 'admin-payroll-' + stamp + '.xlsx');
}

$('adminSignin').addEventListener('click', adminSignIn);
$('adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') adminSignIn(); });
$('adminUser').addEventListener('keydown', e => { if (e.key === 'Enter') $('adminPass').focus(); });
$('adminSignout').addEventListener('click', adminSignOut);
$('refreshAdmin').addEventListener('click', loadAdminDashboard);
$('exportAdmin').addEventListener('click', exportAdminExcel);

// =========================== AUTO-RESUME ===========================
try {
  if (sessionStorage.getItem('tt_admin') === '1') {
    loadAdminDashboard();
  } else {
    const saved = JSON.parse(sessionStorage.getItem('tt_worker') || 'null');
    if (saved && saved.name && saved.pin) {
      nameEl.value = saved.name; pinEl.value = saved.pin;
      show('workerLogin');
      workerSignIn();
    } else {
      show('landing');
    }
  }
} catch { show('landing'); }

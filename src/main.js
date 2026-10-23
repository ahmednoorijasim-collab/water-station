import * as F from './fb.js';
import L from 'leaflet';
import * as XLSX from 'xlsx';

const { auth, db } = F;
const $ = s => document.querySelector(s);
const app = () => $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d.-]/g, '')) || 0;
const digits = v => String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
const phone10 = v => digits(v).slice(-10);
const tankId = v => digits(v).replace(/^0+(?=\d{4,})/, '') || digits(v);
const fmt = n => Number(n || 0).toLocaleString('en-US');
const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const toDate = t => (t && t.toDate ? t.toDate() : t instanceof Date ? t : null);
const daysSince = t => { const d = toDate(t); return d ? Math.floor((Date.now() - d.getTime()) / 864e5) : null; };
const dateTxt = t => { const d = toDate(t); return d ? d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') : '—'; };
const timeTxt = t => { const d = toDate(t); return d ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''; };
const ago = t => {
  const d = toDate(t); if (!d) return 'الآن';
  const m = Math.floor((Date.now() - d.getTime()) / 6e4);
  if (m < 1) return 'الآن'; if (m < 60) return 'قبل ' + m + ' دقيقة';
  const h = Math.floor(m / 60); if (h < 24) return 'قبل ' + h + ' ساعة';
  return 'قبل ' + Math.floor(h / 24) + ' يوم';
};
const dist = (a, b) => {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const STATION = { lat: 34.3486, lng: 45.3906 };
const mapsTo = (lat, lng) => 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng;
const errText = e => {
  const c = (e && e.code) || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'الرقم أو الرمز غلط.';
  if (c.includes('email-already-in-use')) return 'هذا الحساب مفعّل من قبل. سجّل دخول بالرمز، وإذا نسيته راجع المحطة.';
  if (c.includes('weak-password')) return 'الرمز لازم يكون 6 أرقام على الأقل.';
  if (c.includes('permission-denied')) return 'ما عندك صلاحية لهذي العملية، أو المعلومات ما تطابق سجلات المحطة.';
  if (c.includes('network') || c.includes('unavailable')) return 'ماكو اتصال بالإنترنت. جرّب مرة ثانية.';
  if (c.includes('too-many-requests')) return 'محاولات كثيرة. انتظر شوية وجرّب.';
  return (e && e.message) || String(e);
};

let toastT;
function toast(t, bad) {
  const el = $('#toast'); el.textContent = t; el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { el.className = 'toast'; }, 4000);
}
function beep() {
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(); setTimeout(() => { o.stop(); c.close(); }, 350);
  } catch {}
}

// ------------------------------------------------------------------ state
const S = {
  user: null, role: null, profile: null,
  settings: { price: 0, tankSize: 500, geo: true },
  unsubs: [],
  // admin
  aTab: 'orders', open: [], doneToday: [], cars: [], due: [], sel: new Set(), map: null, markers: {},
  // customer
  tank: null, myOrders: [], notices: [],
  // driver
  car: null, route: [], myDone: [], watchId: null, lastSent: 0, here: null
};
function stopAll() { S.unsubs.forEach(u => { try { u(); } catch {} }); S.unsubs = []; if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } if (S.map) { S.map.remove(); S.map = null; S.markers = {}; } }
function listen(q, fn, onErr) { S.unsubs.push(F.onSnapshot(q, fn, e => { console.error(e); (onErr || (x => toast(errText(x), true)))(e); })); }
function watchSettings(after) {
  listen(F.doc(db, 'settings', 'main'), s => { S.settings = { price: 0, tankSize: 500, geo: true, ...(s.exists() ? s.data() : {}) }; after && after(); });
}
const perTrip = car => Math.max(1, Math.floor(num(car && car.cap || 3500) / (num(S.settings.tankSize) || 500)));
const tankL = () => num(S.settings.tankSize) || 500;
// water level of a car: null when never filled in the app
const waterOf = c => (c && c.water != null ? Math.max(0, num(c.water)) : null);
const waterState = c => { const w = waterOf(c); if (w == null) return 'unknown'; if (w < tankL()) return 'empty'; if (w <= 2 * tankL()) return 'low'; return 'ok'; };
function gauge(c, big) {
  const cap = num(c && c.cap) || 3500, w = waterOf(c), st = waterState(c);
  const pct = w == null ? 0 : Math.min(100, Math.round(w / cap * 100));
  const label = w == null ? 'غير معروف' : fmt(w) + ' لتر';
  return `<div class="gauge ${st}${big ? ' big' : ''}"><div class="gtrack"><i style="width:${pct}%"></i></div><span>${label}${w != null ? ' من ' + fmt(cap) : ''}</span></div>`;
}
const priceTxt = () => num(S.settings.price) > 0 ? fmt(S.settings.price) + ' د.ع' : 'لم يُحدد بعد';

// ------------------------------------------------------------------ boot
F.onAuthStateChanged(auth, async u => {
  stopAll(); S.user = u; S.role = null; S.profile = null;
  Object.assign(S, { aTab: 'orders', open: [], doneToday: [], cars: [], due: [], sel: new Set(), tank: null, myOrders: [], notices: [], car: null, route: [], myDone: [], _seenOnce: false, _dSeen: false, _carsSeen: false });
  if (!u) return renderLogin();
  app().innerHTML = '<div class="center"><div class="spin"></div></div>';
  try {
    if (u.email === F.ADMIN_EMAIL) { S.role = 'admin'; return startAdmin(); }
    const p = await F.getDoc(F.doc(db, 'users', u.uid));
    if (!p.exists()) { await F.signOut(auth); return renderLogin('هذا الحساب غير مربوط بخزان أو سيارة. راجع المحطة.'); }
    S.profile = p.data(); S.role = S.profile.role;
    if (S.role === 'customer') return startCustomer();
    if (S.role === 'driver') return startDriver();
    await F.signOut(auth);
  } catch (e) { renderLogin(errText(e)); }
});

function shell(title, sub, body, tabs) {
  app().innerHTML = `
    <header class="top">
      <div class="brand"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7cc6ec" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7c3.5 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.8 6-11z"/></svg>
        <div><b>${esc(title)}</b><small>${esc(sub)}</small></div></div>
      <button class="ghost" data-act="logout" type="button">خروج</button>
    </header>
    ${tabs || ''}
    <main id="main">${body}</main>`;
}

// ------------------------------------------------------------------ login
let loginMode = 'pick';
function renderLogin(msg) {
  const m = loginMode;
  const back = '<button class="link" type="button" data-act="lmode" data-k="pick">رجوع</button>';
  const titles = { customer: 'دخول المشترك', activate: 'تفعيل حساب المشترك', driver: 'دخول السائق', admin: 'دخول الإدارة' };
  let form = '';
  if (m === 'customer') form = `
      <label for="lTank">رقم الخزان</label><input id="lTank" inputmode="numeric" autocomplete="username">
      <label for="lPin">الرمز السري</label><input id="lPin" type="password" inputmode="numeric" autocomplete="current-password">
      <button class="primary" type="submit">دخول</button>
      <button class="link" type="button" data-act="lmode" data-k="activate">أول مرة؟ فعّل حسابك</button>${back}`;
  if (m === 'activate') form = `
      <p class="hint">اكتب رقم خزانك ورقم الموبايل المسجّل بالمحطة، واختار رمز سري من 6 أرقام.</p>
      <label for="aTank">رقم الخزان</label><input id="aTank" inputmode="numeric">
      <label for="aPhone">رقم الموبايل</label><input id="aPhone" inputmode="tel" placeholder="07xxxxxxxxx">
      <label for="aPin">اختار رمز سري (6 أرقام)</label><input id="aPin" type="password" inputmode="numeric" maxlength="12">
      <button class="primary" type="submit">تفعيل الحساب</button>
      <button class="link" type="button" data-act="lmode" data-k="customer">رجوع لتسجيل الدخول</button>`;
  if (m === 'driver') form = `
      <label for="lCar">رقم السيارة</label><input id="lCar" inputmode="numeric">
      <label for="lCpin">الرمز السري</label><input id="lCpin" type="password" inputmode="numeric">
      <button class="primary" type="submit">دخول</button>${back}`;
  if (m === 'admin') form = `
      <label for="lAdm">كلمة سر الإدارة</label><input id="lAdm" type="password" autocomplete="current-password">
      <button class="primary" type="submit">دخول</button>${back}`;
  app().innerHTML = `
    <div class="login">
      <div class="logo"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#1479b5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7c3.5 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.8 6-11z"/></svg></div>
      <h1>محطة الماء المركزية</h1>
      <p class="hint">خانقين</p>
      ${m === 'pick' ? `<div class="roles">
        <button type="button" class="role r1" data-act="lmode" data-k="customer">أنا مشترك<small>اطلب تعبئة خزانك وتابع طلبك</small></button>
        <button type="button" class="role r2" data-act="lmode" data-k="driver">السائقين</button>
        <button type="button" class="role r3" data-act="lmode" data-k="admin">الإدارة</button>
        ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
      </div>` : `<form id="loginForm" class="card form"><h2>${titles[m]}</h2>${form}<p class="err" id="lErr">${esc(msg || '')}</p></form>`}
    </div>`;
}
async function doLogin(e) {
  e.preventDefault();
  const err = $('#lErr'); err.textContent = '';
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    if (loginMode === 'customer') {
      const id = tankId($('#lTank').value); if (!id) throw { message: 'اكتب رقم الخزان.' };
      await F.signInWithEmailAndPassword(auth, F.tankEmail(id), $('#lPin').value);
    } else if (loginMode === 'driver') {
      const n = digits($('#lCar').value); if (!n) throw { message: 'اكتب رقم السيارة.' };
      await F.signInWithEmailAndPassword(auth, F.carEmail(Number(n)), $('#lCpin').value);
    } else if (loginMode === 'admin') {
      await F.signInWithEmailAndPassword(auth, F.ADMIN_EMAIL, $('#lAdm').value);
    } else if (loginMode === 'activate') {
      const id = tankId($('#aTank').value), ph = phone10($('#aPhone').value), pin = $('#aPin').value;
      if (!id || ph.length < 10) throw { message: 'تأكد من رقم الخزان ورقم الموبايل.' };
      if (digits(pin).length < 6) throw { message: 'الرمز لازم يكون 6 أرقام على الأقل.' };
      const cred = await F.createUserWithEmailAndPassword(auth, F.tankEmail(id), pin);
      try {
        await F.setDoc(F.doc(db, 'users', cred.user.uid), { role: 'customer', tankId: id, phone: ph });
        await F.updateDoc(F.doc(db, 'tanks', id), { uid: cred.user.uid });
        loginMode = 'customer';
        // re-trigger the auth handler now that the profile exists
        await F.signOut(auth); await F.signInWithEmailAndPassword(auth, F.tankEmail(id), pin);
        toast('تفعّل حسابك. أهلاً بيك!');
      } catch (e2) {
        await F.deleteUser(cred.user).catch(() => {});
        throw { message: 'رقم الخزان أو رقم الموبايل ما يطابق سجلات المحطة. راجع المحطة حتى يتأكدون من معلوماتك.' };
      }
    }
  } catch (x) { err.textContent = errText(x); btn.disabled = false; }
}

// ------------------------------------------------------------------ customer
function startCustomer() {
  const id = S.profile.tankId;
  shell('محطة الماء المركزية', 'خزان رقم ' + id, `
    <div id="cNotes"></div>
    <section class="card tankcard" id="cTank"><div class="spin"></div></section>
    <div id="cAction"></div>
    <section><h2>سجل التعبئة</h2><div id="cHist" class="list"></div></section>`);
  watchSettings(renderCustomer);
  const tick = setInterval(renderCustomer, 5 * 6e4); S.unsubs.push(() => clearInterval(tick));
  listen(F.doc(db, 'tanks', id), s => { S.tank = s.exists() ? { id: s.id, ...s.data() } : null; renderCustomer(); });
  listen(F.query(F.collection(db, 'orders'), F.where('uid', '==', S.user.uid)), qs => {
    const before = S.myOrders.find(o => o.status !== 'done');
    S.myOrders = qs.docs.map(d => ({ id: d.id, ...d.data() }));
    const now = S.myOrders.find(o => o.id === (before && before.id));
    if (before && now && before.status !== now.status) beep();
    renderCustomer();
  });
  listen(F.query(F.collection(db, 'notices'), F.where('tankId', '==', id)), qs => {
    S.notices = qs.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(n => (daysSince(n.createdAt) ?? 0) <= 10).sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0)).slice(0, 2);
    renderCustomer();
  });
}
function renderCustomer() {
  if (S.role !== 'customer' || !$('#cTank')) return;
  const t = S.tank;
  $('#cTank').innerHTML = t ? `
    <div class="row"><span class="muted">خزان رقم</span><span class="muted">${esc(t.area)}</span></div>
    <div class="big">${esc(t.id)}</div>
    <div class="strong">${esc(t.name)}</div>
    <div class="muted">آخر تعبئة: ${t.lastFillAt ? (daysSince(t.lastFillAt) === 0 ? 'اليوم' : 'قبل ' + daysSince(t.lastFillAt) + ' يوم') : '—'} · سعر التعبئة: ${priceTxt()}</div>` : '<p class="muted">ما لگينا معلومات خزانك. راجع المحطة.</p>';
  const open = S.myOrders.filter(o => o.status !== 'done').sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0))[0];
  const dot = on => `<span class="dot ${on ? 'on' : ''}"></span>`;
  $('#cAction').innerHTML = open ? `
    <section class="card">
      <h2>حالة طلبك</h2>
      ${open.note ? `<div class="note">ملاحظتك: ${esc(open.note)}</div>` : ''}
      <div class="steps">
        <div>${dot(true)}<span>وصل طلبك للمحطة · ${ago(open.createdAt)}</span></div>
        <div>${dot(open.status === 'assigned')}<span>${open.status === 'assigned' ? 'سيارة رقم ' + esc(open.carNo) + ' بالطريق إليك' : 'بانتظار تخصيص سيارة'}</span></div>
        <div>${dot(false)}<span>تمت التعبئة</span></div>
      </div>
      ${late(open) ? `<div class="latebox"><span>تأخر طلبك أكثر من 24 ساعة؟ تگدر تتصل بالمحطة.</span>
        <a class="callbtn" href="tel:${esc(stationTel())}">اتصل بالمحطة <span dir="ltr">${esc(stationTel())}</span></a></div>` : ''}
    </section>` : `
    <button type="button" class="request" data-act="openReq" ${t ? '' : 'disabled'}>
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7c3.5 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.8 6-11z"/><path d="M9 14h6"/><path d="M12 11v6"/></svg>
      طلب إعادة تعبئة<small>يوصل طلبك للمحطة مباشرة</small>
    </button>`;
  const hist = S.myOrders.filter(o => o.status === 'done').sort((a, b) => (toDate(b.doneAt) || 0) - (toDate(a.doneAt) || 0)).slice(0, 24);
  $('#cHist').innerHTML = hist.length ? hist.map(o => `
    <div class="hrow"><b>${dateTxt(o.doneAt)}</b><span>${timeTxt(o.doneAt)}</span><span>سيارة ${esc(o.carNo)}</span></div>`).join('')
    : '<p class="muted">ماكو تعبئات مسجلة بعد.</p>';
  $('#cNotes').innerHTML = S.notices.map(n => `
    <div class="notice"><b>${esc(n.title)}</b><span>${esc(n.body)}</span></div>`).join('');
}
const stationTel = () => digits(S.settings.phone || '');
function late(o) {
  const c = toDate(o.createdAt);
  return !!(o.status !== 'done' && stationTel() && c && Date.now() - c.getTime() > 24 * 36e5);
}
const QUICK = ['الصبح', 'الظهر', 'العصر', 'أي وقت', 'اتصل قبل ما توصل'];
function openRequestSheet() {
  const box = document.createElement('div'); box.className = 'sheetwrap'; box.id = 'reqSheet';
  box.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="reqT">
      <h2 id="reqT">طلب إعادة تعبئة</h2>
      <p class="hint">إذا عندك ملاحظة للسائق اختارها أو اكتبها. هذا اختياري.</p>
      <div class="chips">${QUICK.map(q => `<button type="button" class="chip" data-act="qchip" aria-pressed="false">${q}</button>`).join('')}</div>
      <label for="reqNote" class="small strong">ملاحظة (اختياري)</label>
      <textarea id="reqNote" maxlength="150" rows="2" placeholder="مثلاً: الخزان على السطح، الباب الخلفي…"></textarea>
      <button type="button" class="primary" data-act="request">أرسل الطلب</button>
      <button type="button" class="link" data-act="closeReq">إلغاء</button>
    </div>`;
  document.body.appendChild(box);
}
function closeRequestSheet() { const s = $('#reqSheet'); if (s) s.remove(); }
function sheetNote() {
  const tags = [...document.querySelectorAll('#reqSheet .chip[aria-pressed="true"]')].map(b => b.textContent);
  const txt = ($('#reqNote') && $('#reqNote').value || '').trim();
  return [...tags, txt].filter(Boolean).join(' · ').slice(0, 200);
}
async function customerRequest(btn) {
  const t = S.tank; if (!t) return;
  const note = sheetNote();
  if (S.myOrders.some(o => o.status !== 'done')) return toast('عندك طلب مفتوح.');
  btn.disabled = true;
  try {
    await F.addDoc(F.collection(db, 'orders'), {
      uid: S.user.uid, tankId: t.id, name: t.name || '', area: t.area || '', phone: t.phone || '',
      lat: t.lat ?? null, lng: t.lng ?? null, lastFillAt: t.lastFillAt || null, note,
      status: 'new', carNo: null, createdAt: F.serverTimestamp(), by: 'customer'
    });
    closeRequestSheet();
    toast('وصل طلبك للمحطة. راح تتحدث الحالة هنا لمن تتحرك السيارة.');
  } catch (e) { toast(errText(e), true); btn.disabled = false; }
}

// ------------------------------------------------------------------ admin
function adminTabs() {
  const b = (k, t) => `<button type="button" class="tab ${S.aTab === k ? 'on' : ''}" data-act="atab" data-k="${k}">${t}</button>`;
  return `<nav class="tabs">${b('orders', 'الطلبات <i id="newBadge"></i>')}${b('cars', 'السيارات')}${b('tanks', 'المشتركين')}${b('settings', 'الإعدادات')}</nav>`;
}
function startAdmin() {
  watchSettings(() => { renderAdmin(); });
  listen(F.query(F.collection(db, 'orders'), F.where('status', 'in', ['new', 'assigned'])), qs => {
    const prevNew = new Set(S.open.filter(o => o.status === 'new').map(o => o.id));
    S.open = qs.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S.open.some(o => o.status === 'new' && !prevNew.has(o.id)) && prevNew.size + S.open.length > 0 && S._seenOnce) beep();
    S._seenOnce = true;
    for (const id of [...S.sel]) if (!S.open.find(o => o.id === id && o.status === 'new')) S.sel.delete(id);
    renderAdmin();
  });
  listen(F.query(F.collection(db, 'orders'), F.where('doneDay', '==', dayKey())), qs => { S.doneToday = qs.docs.map(d => ({ id: d.id, ...d.data() })); renderAdmin(); });
  listen(F.collection(db, 'cars'), qs => {
    const wasDry = new Set(S.cars.filter(c => waterState(c) === 'empty').map(c => c.n));
    S.cars = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.n - b.n);
    const nowDry = S.cars.filter(c => waterState(c) === 'empty' && !wasDry.has(c.n));
    if (S._carsSeen && nowDry.length) { beep(); toast(nowDry.map(c => 'سيارة ' + c.n).join('، ') + ' بحاجة إلى إعادة تعبئة.', true); }
    S._carsSeen = true; renderAdmin();
  });
  loadDue();
  drawAdminTab();
}
async function loadDue() {
  try {
    const cutoff = F.Timestamp.fromDate(new Date(Date.now() - 25 * 864e5));
    const qs = await F.getDocs(F.query(F.collection(db, 'tanks'), F.where('lastFillAt', '<=', cutoff), F.orderBy('lastFillAt'), F.limit(150)));
    S.due = qs.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdmin();
  } catch (e) { console.error(e); }
}
function drawAdminTab() {
  const k = S.aTab;
  let body = '';
  if (k === 'orders') body = `
    <div id="dryBanner"></div>
    <div class="kpis" id="kpis"></div>
    <section><div class="row"><h2>طلبات جديدة</h2><span class="muted small">حسب الأولوية</span></div>
      <div id="picks" class="chips"></div><div id="newList" class="list"></div></section>
    <section><h2>بالطريق</h2><div id="asgList" class="list"></div></section>
    <section class="card form">
      <h2>طلب بالتلفون</h2>
      <p class="hint">للمشتركين اللي يتصلون بالمحطة بدل التطبيق.</p>
      <input id="phTank" inputmode="numeric" placeholder="رقم الخزان" aria-label="رقم الخزان">
      <input id="phNote" maxlength="150" placeholder="ملاحظة للسائق (اختياري)" aria-label="ملاحظة للسائق">
      <button type="button" class="primary" data-act="phoneOrder">إنشاء طلب</button>
    </section>
    <section><div class="row"><h2>قرب موعد التعبئة الشهري</h2><button class="link" type="button" data-act="reloadDue">تحديث</button></div><div id="dueList" class="list"></div></section>
    <div id="assignBar" class="assignbar" hidden></div>`;
  if (k === 'cars') body = `
    <section><div class="row"><h2>موقع السيارات</h2><span class="muted small">يتحدث كل دقيقة أثناء الدوام</span></div>
      <div id="map" class="map" role="img" aria-label="خريطة مواقع السيارات"></div></section>
    <section><h2>السيارات</h2><div id="carList" class="list"></div></section>
    <section class="card form">
      <h2>إضافة سيارة جديدة</h2>
      <label for="ncNo">رقم السيارة</label><input id="ncNo" inputmode="numeric">
      <label for="ncCap">الحمولة (لتر)</label><input id="ncCap" inputmode="numeric" value="3500">
      <label for="ncPin">رمز دخول السائق (6 أرقام)</label><input id="ncPin" inputmode="numeric">
      <button type="button" class="primary" data-act="addCar">إضافة السيارة</button>
    </section>`;
  if (k === 'tanks') body = `
    <section class="card form">
      <h2>المشتركين <span class="muted" id="tCount"></span></h2>
      <p class="hint">ارفع ملف Excel بالأعمدة: <b>رقم الخزان، اسم صاحب الخزان، الحي، رقم الموبايل</b>، واختيارياً: <b>خط العرض، خط الطول، آخر تعبئة</b>. السطر الأول عناوين.</p>
      <label class="primary filebtn" for="xls">اختيار ملف Excel</label>
      <input id="xls" type="file" accept=".xlsx,.xls,.csv" class="vh">
      <div id="impOut"></div>
    </section>
    <section class="card form">
      <h2>بحث عن خزان</h2>
      <div class="inline"><input id="qTank" inputmode="numeric" placeholder="رقم الخزان" aria-label="رقم الخزان"><button type="button" class="primary" data-act="findTank">بحث</button></div>
      <div id="tankOut"></div>
    </section>
    <section class="card form">
      <h2>إضافة خزان</h2>
      <label for="ntId">رقم الخزان</label><input id="ntId" inputmode="numeric">
      <label for="ntName">اسم صاحب الخزان</label><input id="ntName">
      <label for="ntArea">الحي</label><input id="ntArea" list="areasList">
      <label for="ntPhone">رقم الموبايل</label><input id="ntPhone" inputmode="tel">
      <datalist id="areasList"></datalist>
      <button type="button" class="primary" data-act="addTank">حفظ الخزان</button>
    </section>`;
  if (k === 'settings') body = `
    <section class="card form">
      <label for="sPrice">سعر التعبئة الثابت (دينار)</label><input id="sPrice" inputmode="numeric" value="${esc(S.settings.price || '')}">
      <label for="sSize">حجم الخزان الافتراضي (لتر)</label><input id="sSize" inputmode="numeric" value="${esc(S.settings.tankSize || 500)}">
      <label for="sPhone">رقم هاتف المحطة</label><input id="sPhone" inputmode="tel" placeholder="07xxxxxxxxx" value="${esc(S.settings.phone || '')}">
      <p class="hint">يظهر للمشترك بس إذا طلبه تأخر أكثر من 24 ساعة بدون تعبئة.</p>
      <label class="check"><input type="checkbox" id="sGeo" ${S.settings.geo ? 'checked' : ''}> التحقق من الموقع عند التعبئة (السائق لازم يكون ضمن 1 كم من الخزان، للخزانات اللي موقعها محفوظ)</label>
      <button type="button" class="primary" data-act="saveSettings">حفظ الإعدادات</button>
    </section>`;
  shell('محطة الماء المركزية', 'لوحة الإدارة', body, adminTabs());
  if (k === 'cars') initMap();
  if (k === 'tanks') countTanks();
  renderAdmin();
}
function renderAdmin() {
  if (S.role !== 'admin' || !$('#main')) return;
  const nNew = S.open.filter(o => o.status === 'new').length;
  const badge = $('#newBadge'); if (badge) badge.textContent = nNew ? '(' + nNew + ')' : '';
  if (S.aTab === 'orders') renderAdminOrders();
  if (S.aTab === 'cars') renderCars();
}
function carLoad(n) { return S.open.filter(o => o.status === 'assigned' && o.carNo === n).length; }
function renderAdminOrders() {
  if (!$('#newList')) return;
  const dry = S.cars.filter(c => waterState(c) === 'empty');
  $('#dryBanner').innerHTML = dry.length ? `<div class="wmsg red">${dry.map(c => 'سيارة ' + c.n).join('، ')} بحاجة إلى إعادة تعبئة (متبقي أقل من ${fmt(tankL())} لتر).</div>` : '';
  const openTanks = new Set(S.open.map(o => o.tankId));
  const due = S.due.filter(t => !openTanks.has(t.id));
  $('#kpis').innerHTML = [
    [nOf('new'), 'جديد', 'blue'], [nOf('assigned'), 'بالطريق', ''], [S.doneToday.length, 'تمت اليوم', 'green'], [due.length, 'قرب الموعد', 'amber']
  ].map(([v, l, c]) => `<div class="kpi ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  const news = S.open.filter(o => o.status === 'new').map(o => ({ ...o, days: daysSince(o.lastFillAt) }))
    .sort((a, b) => ((b.days ?? 0) >= 30) - ((a.days ?? 0) >= 30) || (toDate(a.createdAt) || 0) - (toDate(b.createdAt) || 0) || String(a.area).localeCompare(String(b.area)));
  const areas = [...new Set(news.map(o => o.area || 'بدون حي'))];
  $('#picks').innerHTML = news.length ? `<button type="button" class="chip" data-act="pick" data-area="*">الكل (${news.length})</button>` +
    areas.map(a => `<button type="button" class="chip" data-act="pick" data-area="${esc(a)}">${esc(a)} (${news.filter(o => (o.area || 'بدون حي') === a).length})</button>`).join('') +
    (S.sel.size ? '<button type="button" class="chip ghostchip" data-act="pick" data-area="">إلغاء الاختيار</button>' : '') : '';
  $('#newList').innerHTML = news.length ? news.map(o => `
    <button type="button" class="ocard ${S.sel.has(o.id) ? 'sel' : ''}" data-act="toggle" data-id="${o.id}" aria-pressed="${S.sel.has(o.id)}">
      <span class="box">${S.sel.has(o.id) ? '✓' : ''}</span>
      <span class="ob"><span class="row"><b>خزان ${esc(o.tankId)} · ${esc(o.name)}</b>${(o.days ?? 0) >= 30 ? '<span class="pill amber">تجاوز الشهر</span>' : ''}</span>
      <span class="muted small">${esc(o.area)} · ${ago(o.createdAt)}${o.days != null ? ' · آخر تعبئة قبل ' + o.days + ' يوم' : ''}${o.by === 'admin' ? ' · بالتلفون' : ''}</span>
      ${o.note ? `<span class="note small">${esc(o.note)}</span>` : ''}</span>
    </button>`).join('') : '<p class="muted card">ماكو طلبات جديدة.</p>';
  const asg = S.open.filter(o => o.status === 'assigned').sort((a, b) => a.carNo - b.carNo);
  $('#asgList').innerHTML = asg.length ? asg.map(o => `
    <div class="lrow"><span>خزان ${esc(o.tankId)} · ${esc(o.area)}${o.note ? `<br><span class="muted small">${esc(o.note)}</span>` : ''}</span><span class="row gap"><b class="blue">سيارة ${esc(o.carNo)}</b><button type="button" class="link small" data-act="unassign" data-id="${o.id}">إرجاع</button></span></div>`).join('')
    : '<p class="muted">ماكو طلبات بالطريق.</p>';
  $('#dueList').innerHTML = due.length ? due.map(t => `
    <div class="duecard">
      <div><b>خزان ${esc(t.id)} · ${esc(t.name)}</b><span class="muted small">آخر تعبئة قبل ${daysSince(t.lastFillAt)} يوم · ${esc(t.area)}${t.uid ? '' : ' · بدون حساب بالتطبيق'}</span></div>
      <div class="two">
        <button type="button" class="${t.remindedDay === dayKey() ? 'done' : 'outline'}" data-act="remind" data-id="${t.id}" ${t.uid ? '' : 'disabled'}>${t.remindedDay === dayKey() ? 'انرسل التذكير ✓' : 'أرسل تذكير'}</button>
        <button type="button" class="amberbtn" data-act="orderFor" data-id="${t.id}">أنشئ طلب</button>
      </div>
    </div>`).join('') : '<p class="muted">ماكو خزانات قربت تكمل شهر.</p>';
  const bar = $('#assignBar');
  if (S.sel.size) {
    bar.hidden = false;
    bar.innerHTML = `<b>خصّص ${S.sel.size} طلب لسيارة رقم:</b><span class="muted small">تحت كل رقم: المخصص / سعة الطلعة</span>
      <div class="chips">${S.cars.length ? S.cars.map(c => `<button type="button" class="carbtn ${waterState(c) === 'empty' ? 'dry' : ''}" data-act="assign" data-n="${c.n}">${c.n}<small>${carLoad(c.n)}/${perTrip(c)}</small></button>`).join('') : '<span class="muted">ضيف السيارات من تبويب السيارات.</span>'}</div>`;
  } else bar.hidden = true;
  function nOf(s) { return S.open.filter(o => o.status === s).length; }
}
async function assignTo(n) {
  const ids = [...S.sel]; if (!ids.length) return;
  const b = F.writeBatch(db);
  ids.forEach(id => b.update(F.doc(db, 'orders', id), { status: 'assigned', carNo: n, assignedAt: F.serverTimestamp() }));
  const car = S.cars.find(c => c.n === n); const total = carLoad(n) + ids.length; const trips = Math.ceil(total / perTrip(car));
  try {
    await b.commit(); S.sel.clear();
    toast(ids.length + ' طلب انخصص لسيارة ' + n + '. صار عندها ' + total + ' خزان = ' + (trips === 1 ? 'طلعة وحدة' : trips + ' طلعات') + '.');
  } catch (e) { toast(errText(e), true); }
}
async function orderForTank(id, by, note = '') {
  id = tankId(id); if (!id) return toast('اكتب رقم الخزان.', true);
  if (S.open.some(o => o.tankId === id)) return toast('هذا الخزان عنده طلب مفتوح.', true);
  try {
    const s = await F.getDoc(F.doc(db, 'tanks', id));
    if (!s.exists()) return toast('ماكو خزان بهذا الرقم.', true);
    const t = s.data();
    await F.addDoc(F.collection(db, 'orders'), {
      uid: t.uid || null, tankId: id, name: t.name || '', area: t.area || '', phone: t.phone || '',
      lat: t.lat ?? null, lng: t.lng ?? null, lastFillAt: t.lastFillAt || null, note: String(note || '').trim().slice(0, 200),
      status: 'new', carNo: null, createdAt: F.serverTimestamp(), by
    });
    toast('انسوى طلب لخزان ' + id + '.');
  } catch (e) { toast(errText(e), true); }
}
async function remind(id) {
  const t = S.due.find(x => x.id === id); if (!t) return;
  try {
    await F.addDoc(F.collection(db, 'notices'), {
      tankId: id, createdAt: F.serverTimestamp(),
      title: 'قرب موعد تعبئة خزانك', body: 'مرت ' + daysSince(t.lastFillAt) + ' يوم على آخر تعبئة. اطلب إعادة تعبئة حتى ما يخلص الماء.'
    });
    await F.updateDoc(F.doc(db, 'tanks', id), { remindedDay: dayKey() });
    t.remindedDay = dayKey(); renderAdmin();
    toast('انرسل تذكير لصاحب خزان ' + id + '.');
  } catch (e) { toast(errText(e), true); }
}

function initMap() {
  const el = $('#map'); if (!el) return;
  S.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([STATION.lat, STATION.lng], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(S.map);
  L.marker([STATION.lat, STATION.lng], { icon: L.divIcon({ className: 'pin station', html: 'م', iconSize: [28, 28] }) }).addTo(S.map).bindTooltip('المحطة');
  S.markers = {}; S.fitted = false;
  setTimeout(() => S.map && S.map.invalidateSize(), 200);
}
function renderCars() {
  if (!$('#carList')) return;
  const busy = new Set(S.open.filter(o => o.status === 'assigned').map(o => o.carNo));
  const cash = n => S.doneToday.filter(o => o.carNo === n).reduce((s, o) => s + num(o.paid), 0);
  $('#carList').innerHTML = S.cars.length ? S.cars.map(c => {
    const seen = toDate(c.seenAt);
    const live = c.onDuty && seen && Date.now() - seen.getTime() < 5 * 6e4;
    return `<div class="carrow">
      <div class="cinfo"><b>سيارة ${c.n}</b> <button type="button" class="link small" data-act="flyCar" data-n="${c.n}">على الخريطة</button>
        <span class="muted small">${busy.has(c.n) ? 'بطلب · ' + carLoad(c.n) + ' خزان' : 'متاحة'} · ${live ? '<span class="green">بالدوام</span>' : 'خارج الدوام'}${seen ? ' · آخر موقع ' + ago(c.seenAt) : ''}</span>
        ${gauge(c)}${waterState(c) === 'empty' ? '<span class="pill red">بحاجة إلى إعادة تعبئة</span>' : ''}
        <span class="muted small">تعبئات اليوم: ${S.doneToday.filter(o => o.carNo === c.n).length} · الكاش: ${fmt(cash(c.n))} د.ع · ${perTrip(c)} خزانات بالطلعة</span></div>
      <div class="capbox"><label for="cap${c.n}" class="small muted">الحمولة (لتر)</label>
        <div class="inline"><input id="cap${c.n}" inputmode="numeric" value="${esc(c.cap)}"><button type="button" class="outline small" data-act="saveCap" data-n="${c.n}">حفظ</button></div></div>
    </div>`;
  }).join('') : '<p class="muted card">ماكو سيارات بعد. ضيفها من تحت.</p>';
  if (S.map) {
    for (const c of S.cars) {
      if (c.lat == null) continue;
      const icon = L.divIcon({ className: 'pin ' + (waterState(c) === 'empty' ? 'empty' : busy.has(c.n) ? 'busy' : 'free'), html: String(c.n), iconSize: [30, 30] });
      if (S.markers[c.n]) S.markers[c.n].setLatLng([c.lat, c.lng]).setIcon(icon);
      else S.markers[c.n] = L.marker([c.lat, c.lng], { icon }).addTo(S.map).bindTooltip('سيارة ' + c.n);
    }
    // show the station and every car, however far
    const pts = S.cars.filter(c => c.lat != null).map(c => [c.lat, c.lng]);
    if (pts.length && !S.fitted) {
      S.fitted = true;
      S.map.fitBounds(L.latLngBounds([[STATION.lat, STATION.lng], ...pts]), { padding: [40, 40], maxZoom: 15 });
    }
  }
}
function flyCar(n) {
  const c = S.cars.find(x => x.n === n);
  if (!c || c.lat == null) return toast('سيارة ' + n + ' ما إلها موقع بعد. السائق لازم يدخل للتطبيق ويدوس «بدأت الدوام» ويسمح بالموقع (GPS).', true);
  if (!S.map) return;
  S.map.setView([c.lat, c.lng], 15);
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function addCar() {
  const n = Number(digits($('#ncNo').value)), cap = num($('#ncCap').value) || 3500, pin = digits($('#ncPin').value);
  if (!n) return toast('اكتب رقم السيارة.', true);
  if (pin.length < 6) return toast('رمز السائق لازم يكون 6 أرقام على الأقل.', true);
  if (S.cars.some(c => c.n === n)) return toast('هذا الرقم موجود.', true);
  try {
    const uid = await F.createLogin(F.carEmail(n), pin);
    await F.setDoc(F.doc(db, 'users', uid), { role: 'driver', carNo: n });
    await F.setDoc(F.doc(db, 'cars', String(n)), { n, cap, uid, onDuty: false, lat: null, lng: null, seenAt: null });
    $('#ncNo').value = ''; $('#ncPin').value = '';
    toast('انضافت سيارة ' + n + '. السائق يدخل برقم السيارة والرمز.');
  } catch (e) { toast(e.code && e.code.includes('email-already-in-use') ? 'حساب هذي السيارة موجود من قبل.' : errText(e), true); }
}
async function countTanks() {
  try { const c = await F.getCountFromServer(F.collection(db, 'tanks')); const el = $('#tCount'); if (el) el.textContent = '(' + fmt(c.data().count) + ')'; } catch {}
}
const HEAD = {
  id: ['رقم الخزان', 'الخزان', 'رقم', 'tank'], name: ['اسم صاحب الخزان', 'الاسم', 'اسم', 'name'], area: ['الحي', 'المنطقة', 'area'],
  phone: ['رقم الموبايل', 'الموبايل', 'الهاتف', 'رقم الهاتف', 'phone'], lat: ['خط العرض', 'lat', 'latitude'], lng: ['خط الطول', 'lng', 'lon', 'longitude'],
  last: ['آخر تعبئة', 'اخر تعبئة', 'last']
};
async function importExcel(file) {
  const out = $('#impOut');
  try {
    out.innerHTML = '<p class="muted">جاري قراءة الملف…</p>';
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    if (rows.length < 2) throw new Error('الملف فارغ.');
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const col = {};
    for (const [k, names] of Object.entries(HEAD)) { const i = head.findIndex(h => names.some(n => h === n.toLowerCase() || h.includes(n.toLowerCase()))); if (i >= 0) col[k] = i; }
    ['id', 'name', 'area', 'phone'].forEach((k, i) => { if (col[k] == null) col[k] = i; });
    const items = []; let bad = 0;
    for (const r of rows.slice(1)) {
      const id = tankId(r[col.id]); if (!id) { if (r.some(x => String(x).trim())) bad++; continue; }
      const lat = col.lat != null ? Number(r[col.lat]) : NaN, lng = col.lng != null ? Number(r[col.lng]) : NaN;
      let last = col.last != null ? r[col.last] : '';
      last = last instanceof Date ? last : (last ? new Date(last) : null);
      items.push({
        id, name: String(r[col.name]).trim(), area: String(r[col.area]).trim(), phone: phone10(r[col.phone]), phoneRaw: String(r[col.phone]).trim(),
        ...(isFinite(lat) && isFinite(lng) && lat && lng ? { lat, lng } : {}),
        lastFillAt: last && !isNaN(last) ? F.Timestamp.fromDate(last) : F.Timestamp.now()
      });
    }
    if (!items.length) throw new Error('ما لگينا أرقام خزانات بالملف. تأكد إن العمود الأول رقم الخزان.');
    out.innerHTML = `<p>لگينا <b>${fmt(items.length)}</b> خزان${bad ? ' (و ' + bad + ' سطر بدون رقم انترك)' : ''}. أمثلة:</p>
      <div class="list small">${items.slice(0, 3).map(t => `<div class="lrow"><span>${esc(t.id)} · ${esc(t.name)}</span><span class="muted">${esc(t.area)} · ${esc(t.phoneRaw)}</span></div>`).join('')}</div>
      <button type="button" class="primary" id="impGo">رفع ${fmt(items.length)} خزان</button><div id="impProg"></div>`;
    $('#impGo').onclick = async () => {
      $('#impGo').disabled = true;
      let done = 0;
      for (let i = 0; i < items.length; i += 400) {
        const b = F.writeBatch(db);
        items.slice(i, i + 400).forEach(t => { const { id, ...data } = t; b.set(F.doc(db, 'tanks', id), { id, ...data, createdAt: F.serverTimestamp() }, { merge: true }); });
        await b.commit(); done = Math.min(items.length, i + 400);
        $('#impProg').innerHTML = `<div class="prog"><i style="width:${Math.round(done / items.length * 100)}%"></i></div><p class="muted small">${fmt(done)} / ${fmt(items.length)}</p>`;
      }
      toast('انرفع ' + fmt(items.length) + ' خزان.'); countTanks(); loadDue();
    };
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
}
async function findTank() {
  const id = tankId($('#qTank').value); const out = $('#tankOut'); if (!id) return;
  try {
    const s = await F.getDoc(F.doc(db, 'tanks', id));
    if (!s.exists()) { out.innerHTML = '<p class="muted">ماكو خزان بهذا الرقم.</p>'; return; }
    const t = s.data();
    out.innerHTML = `<div class="tankinfo">
      <b>خزان ${esc(id)} · ${esc(t.name)}</b>
      <span class="muted small">${esc(t.area)} · ${esc(t.phoneRaw || t.phone)}</span>
      <span class="small">آخر تعبئة: ${t.lastFillAt ? dateTxt(t.lastFillAt) + ' (قبل ' + daysSince(t.lastFillAt) + ' يوم)' : '—'}</span>
      <span class="small">الموقع: ${t.lat != null ? '<span class="green">محفوظ</span>' : 'غير محفوظ (يحفظه السائق بأول زيارة)'}</span>
      <span class="small">حساب بالتطبيق: ${t.uid ? '<span class="green">مفعّل</span>' : 'غير مفعّل'}</span>
      <div class="two"><button type="button" class="amberbtn" data-act="orderFor" data-id="${esc(id)}">إنشاء طلب</button>
      ${t.uid ? '' : `<button type="button" class="outline" data-act="makeLogin" data-id="${esc(id)}">إنشاء حساب برمز</button>`}</div>
      <div id="mkLogin"></div></div>`;
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
}
async function makeCustomerLogin(id) {
  $('#mkLogin').innerHTML = `<div class="inline"><input id="mkPin" inputmode="numeric" placeholder="رمز من 6 أرقام" aria-label="رمز المشترك"><button type="button" class="primary" data-act="makeLoginGo" data-id="${esc(id)}">إنشاء</button></div>
    <p class="hint">للمشتركين اللي ما عندهم رقم موبايل بالسجل. أعطِ المشترك رقم خزانه وهذا الرمز.</p>`;
}
async function makeCustomerLoginGo(id) {
  const pin = digits($('#mkPin').value); if (pin.length < 6) return toast('الرمز لازم 6 أرقام على الأقل.', true);
  try {
    const s = await F.getDoc(F.doc(db, 'tanks', id)); const t = s.data() || {};
    const uid = await F.createLogin(F.tankEmail(id), pin);
    await F.setDoc(F.doc(db, 'users', uid), { role: 'customer', tankId: id, phone: t.phone || '' });
    await F.updateDoc(F.doc(db, 'tanks', id), { uid });
    toast('انسوى الحساب. المشترك يدخل برقم الخزان ' + id + ' والرمز.'); findTank();
  } catch (e) { toast(e.code && e.code.includes('email-already-in-use') ? 'هذا الخزان عنده حساب من قبل.' : errText(e), true); }
}
async function addTank() {
  const id = tankId($('#ntId').value); if (!id) return toast('اكتب رقم الخزان.', true);
  try {
    await F.setDoc(F.doc(db, 'tanks', id), {
      id, name: $('#ntName').value.trim(), area: $('#ntArea').value.trim(), phone: phone10($('#ntPhone').value), phoneRaw: $('#ntPhone').value.trim(),
      lastFillAt: F.Timestamp.now(), createdAt: F.serverTimestamp()
    }, { merge: true });
    ['#ntId', '#ntName', '#ntArea', '#ntPhone'].forEach(s => { $(s).value = ''; });
    toast('انحفظ خزان ' + id + '.'); countTanks();
  } catch (e) { toast(errText(e), true); }
}
async function saveSettings() {
  try {
    await F.setDoc(F.doc(db, 'settings', 'main'), { price: num($('#sPrice').value), tankSize: num($('#sSize').value) || 500, geo: $('#sGeo').checked, phone: digits($('#sPhone').value) }, { merge: true });
    toast('انحفظت الإعدادات.');
  } catch (e) { toast(errText(e), true); }
}

// ------------------------------------------------------------------ driver
function startDriver() {
  const n = S.profile.carNo;
  shell('محطة الماء المركزية', 'سيارة رقم ' + n, `
    <section class="card duty" id="duty"></section>
    <section class="card water" id="water"></section>
    <div class="row"><h2>مسار اليوم <span id="rCount" class="muted"></span></h2><span class="muted small">مرتب حسب الحي</span></div>
    <div id="routeAll"></div>
    <div id="route" class="list"></div>
    <section class="card"><div class="row"><b>تعبئات اليوم</b><b id="dToday"></b></div><div class="row"><span class="muted">الكاش المستلم</span><b id="dCash"></b></div></section>`);
  watchSettings(renderDriver);
  listen(F.doc(db, 'cars', String(n)), s => { S.car = s.exists() ? s.data() : { n, cap: 3500 }; renderDriver(); });
  listen(F.query(F.collection(db, 'orders'), F.where('carNo', '==', n), F.where('status', '==', 'assigned')), qs => {
    const before = new Set(S.route.map(o => o.id));
    S.route = qs.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S._dSeen && S.route.some(o => !before.has(o.id))) { beep(); toast('وصلتك طلبات جديدة من المحطة.'); }
    S._dSeen = true; renderDriver();
  });
  listen(F.query(F.collection(db, 'orders'), F.where('carNo', '==', n), F.where('doneDay', '==', dayKey())), qs => { S.myDone = qs.docs.map(d => d.data()); renderDriver(); });
  try { if (localStorage.getItem('onDuty') === '1') startDuty(); } catch {}
}
function renderDriver() {
  if (S.role !== 'driver' || !$('#route')) return;
  const on = S.watchId != null;
  $('#duty').innerHTML = `<div class="row"><div><b>${on ? 'بالدوام' : 'خارج الدوام'}</b><span class="muted small">${on ? 'موقع السيارة يوصل للمحطة' : 'ابدأ الدوام حتى المحطة تشوف موقعك'}</span></div>
    <button type="button" class="${on ? 'outline' : 'primary'}" data-act="duty">${on ? 'إنهاء الدوام' : 'بدأت الدوام'}</button></div>`;
  renderWater();
  const rank = a => String(a || '');
  const list = [...S.route].sort((a, b) => rank(a.area).localeCompare(rank(b.area)) || String(a.tankId).localeCompare(String(b.tankId)));
  const per = perTrip(S.car);
  $('#rCount').textContent = '(' + list.length + ' خزان)';
  const pts = list.filter(o => o.lat != null).map(o => o.lat + ',' + o.lng);
  $('#routeAll').innerHTML = pts.length > 1 ? `<a class="routebtn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${STATION.lat},${STATION.lng}&destination=${pts.slice(0, 10).slice(-1)[0]}&waypoints=${encodeURIComponent(pts.slice(0, 9).join('|'))}">افتح المسار كامل بالخريطة</a>` : '';
  $('#route').innerHTML = list.length ? list.map((o, i) => {
    const trip = Math.floor(i / per) + 1, inTrip = Math.min(per, list.length - (trip - 1) * per);
    const head = i % per === 0 ? `${i > 0 ? '<div class="back">ارجع للمحطة وعبّي الحوضية قبل الطلعة الجاية</div>' : ''}<div class="trip">الطلعة ${trip} · ${inTrip} خزانات · ${fmt(inTrip * (num(S.settings.tankSize) || 500))} لتر</div>` : '';
    const has = o.lat != null;
    return head + `<div class="card stop">
      <div class="row"><span class="row gap"><span class="seq">${i + 1}</span><b class="big2">خزان ${esc(o.tankId)}</b></span></div>
      <div class="addr"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg><span>${esc(o.area || 'بدون حي')}</span></div>
      <div class="owner">${esc(o.name)}</div>
      ${o.note ? `<div class="drvnote"><b>ملاحظة المشترك</b><span>${esc(o.note)}</span></div>` : ''}
      ${o.phone ? `<a class="callbtn" href="tel:0${esc(o.phone)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>اتصال بالمشترك <span dir="ltr">0${esc(o.phone)}</span></a>` : '<div class="muted small">ماكو رقم موبايل مسجّل لهذا المشترك.</div>'}
      ${has ? `<a class="navbtn" target="_blank" rel="noopener" href="${mapsTo(o.lat, o.lng)}">اذهب للخزان (GPS)</a>`
            : `<div class="warn">أول زيارة: موقع الخزان مو محفوظ. لمن توصل، احفظه.</div><button type="button" class="dashed" data-act="saveLoc" data-id="${o.id}">حفظ موقع الخزان هنا</button>`}
      ${has ? `<button type="button" class="link small" data-act="saveLoc" data-id="${o.id}" data-upd="1">الخزان انتقل لمكان ثاني؟ حدّث موقعه هنا</button>` : ''}
      ${S.settings.geo && has ? '<div class="muted small">زر التعبئة يشتغل لمن تكون قرب الخزان (ضمن 1 كم).</div>' : ''}
      <button type="button" class="finish" data-act="finish" data-id="${o.id}">تمت التعبئة<small>واستلمت ${priceTxt()} كاش</small></button>
    </div>`;
  }).join('') : '<p class="muted card">ماكو طلبات لهذي السيارة هسه. لمن الإدارة تخصصلك طلب يوصلك تنبيه.</p>';
  $('#dToday').textContent = S.myDone.length;
  $('#dCash').textContent = fmt(S.myDone.reduce((s, o) => s + num(o.paid), 0)) + ' د.ع';
}
function renderWater() {
  const el = $('#water'); if (!el) return;
  const c = S.car || {}, w = waterOf(c), st = waterState(c);
  const msg = st === 'empty' ? '<div class="wmsg red">السيارة بحاجة إلى إعادة تعبئة. ارجع للمحطة وعبّي الحوضية.</div>'
    : st === 'low' ? `<div class="wmsg amber">متبقي لديك ${fmt(w)} لتر، يكفي ${Math.floor(w / tankL())} خزان فقط.</div>`
    : st === 'unknown' ? '<div class="wmsg">لمن تعبّي الحوضية بالمحطة، اضغط الزر حتى يبدأ العدّاد.</div>' : '';
  el.innerHTML = `<div class="row"><b>ماء الحوضية</b><span class="muted small">يكفي ${w == null ? '—' : Math.floor(w / tankL())} خزان</span></div>
    ${gauge(c, true)}${msg}
    <button type="button" class="${st === 'empty' || st === 'unknown' ? 'primary' : 'outline'}" data-act="refill">عبّيت الحوضية بالمحطة (${fmt(num(c.cap) || 3500)} لتر)</button>`;
}
async function refillCar(btn) {
  btn.disabled = true;
  try {
    await F.updateDoc(F.doc(db, 'cars', String(S.profile.carNo)), { water: num(S.car && S.car.cap) || 3500, waterAt: F.serverTimestamp() });
    S._waterWarn = null;
    toast('تعبّت الحوضية. العدّاد رجع ' + fmt(num(S.car && S.car.cap) || 3500) + ' لتر.');
  } catch (e) { toast(errText(e) + ' (حدّث قواعد Firestore)', true); btn.disabled = false; }
}
function getPos() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej({ message: 'الموبايل ما يدعم تحديد الموقع.' });
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej({ message: e.code === 1 ? 'لازم تسمح للتطبيق بالوصول للموقع (GPS) من الإعدادات.' : 'ما گدرنا نحدد موقعك. تأكد إن الـ GPS شغال وجرّب بمكان مفتوح.' }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  });
}
function startDuty() {
  if (!navigator.geolocation) return toast('الموبايل ما يدعم تحديد الموقع.', true);
  S.watchId = navigator.geolocation.watchPosition(p => {
    S.here = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    if (Date.now() - S.lastSent > 60000) {
      S.lastSent = Date.now();
      F.updateDoc(F.doc(db, 'cars', String(S.profile.carNo)), { lat: S.here.lat, lng: S.here.lng, acc: Math.round(S.here.acc), seenAt: F.serverTimestamp(), onDuty: true }).catch(e => console.warn(e));
    }
  }, e => toast(e.code === 1 ? 'اسمح للتطبيق بالوصول للموقع حتى المحطة تشوفك.' : 'ما گدرنا نحدد موقعك.', true), { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  try { localStorage.setItem('onDuty', '1'); } catch {}
  renderDriver();
}
async function stopDuty() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId); S.watchId = null;
  try { localStorage.setItem('onDuty', '0'); } catch {}
  F.updateDoc(F.doc(db, 'cars', String(S.profile.carNo)), { onDuty: false, seenAt: F.serverTimestamp() }).catch(() => {});
  renderDriver();
}
async function saveLoc(id, btn) {
  const o = S.route.find(x => x.id === id); if (!o) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'جاري تحديد الموقع…';
  try {
    const p = await getPos();
    if (p.acc > 80) toast('دقة الموقع ضعيفة (' + Math.round(p.acc) + ' م). انحفظ، بس الأفضل تعيده بمكان مفتوح.');
    const b = F.writeBatch(db);
    b.update(F.doc(db, 'tanks', o.tankId), { lat: p.lat, lng: p.lng });
    b.update(F.doc(db, 'orders', id), { lat: p.lat, lng: p.lng });
    await b.commit();
    toast((btn.dataset.upd ? 'تحدّث موقع خزان ' : 'انحفظ موقع خزان ') + o.tankId + '. المرة الجاية يطلعلك الطريق مباشرة.');
  } catch (e) { toast(errText(e), true); btn.disabled = false; btn.textContent = label; }
}
async function finish(id, btn) {
  const o = S.route.find(x => x.id === id); if (!o) return;
  btn.disabled = true;
  try {
    if (S.settings.geo && o.lat != null) {
      const p = await getPos();
      const d = dist(p, { lat: o.lat, lng: o.lng });
      if (d > 1000 + Math.min(p.acc || 0, 100)) { btn.disabled = false; return toast('أنت بعيد عن الخزان (' + (d >= 1000 ? (d / 1000).toFixed(1) + ' كم' : Math.round(d) + ' متر') + '). إذا الخزان انتقل لمكان جديد، دوس «حدّث موقعه هنا» وبعدها سجّل التعبئة.', true); }
    }
    const b = F.writeBatch(db);
    b.update(F.doc(db, 'orders', id), { status: 'done', doneAt: F.serverTimestamp(), doneDay: dayKey(), paid: num(S.settings.price) });
    b.update(F.doc(db, 'tanks', o.tankId), { lastFillAt: F.serverTimestamp() });
    await b.commit();
    toast('تمت تعبئة خزان ' + o.tankId + '.');
    const w = waterOf(S.car);
    if (w != null) {
      const left = Math.max(0, w - tankL());
      F.updateDoc(F.doc(db, 'cars', String(S.profile.carNo)), { water: left, waterAt: F.serverTimestamp() }).catch(e => console.warn(e));
      if (left < tankL()) { beep(); setTimeout(() => toast('السيارة بحاجة إلى إعادة تعبئة. متبقي ' + fmt(left) + ' لتر.', true), 1600); }
      else if (left <= 2 * tankL()) setTimeout(() => toast('متبقي لديك ' + fmt(left) + ' لتر.'), 1600);
    }
  } catch (e) { toast(errText(e), true); btn.disabled = false; }
}

// ------------------------------------------------------------------ events
document.addEventListener('submit', e => { if (e.target.id === 'loginForm') doLogin(e); });
document.addEventListener('change', e => { if (e.target.id === 'xls' && e.target.files[0]) { importExcel(e.target.files[0]); e.target.value = ''; } });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'lmode') { loginMode = b.dataset.k; renderLogin(); }
  else if (a === 'logout') { if (S.role === 'driver' && S.watchId != null) await stopDuty(); await F.signOut(auth); }
  else if (a === 'openReq') openRequestSheet();
  else if (a === 'closeReq') closeRequestSheet();
  else if (a === 'qchip') { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on); b.classList.toggle('on', on); }
  else if (a === 'request') customerRequest(b);
  else if (a === 'atab') { S.aTab = b.dataset.k; if (S.map) { S.map.remove(); S.map = null; } drawAdminTab(); }
  else if (a === 'toggle') { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); renderAdmin(); }
  else if (a === 'pick') {
    const ar = b.dataset.area; S.sel.clear();
    if (ar) S.open.filter(o => o.status === 'new' && (ar === '*' || (o.area || 'بدون حي') === ar)).forEach(o => S.sel.add(o.id));
    renderAdmin();
  }
  else if (a === 'assign') assignTo(Number(b.dataset.n));
  else if (a === 'unassign') { try { await F.updateDoc(F.doc(db, 'orders', id), { status: 'new', carNo: null }); toast('رجع الطلب للطلبات الجديدة.'); } catch (x) { toast(errText(x), true); } }
  else if (a === 'phoneOrder') { await orderForTank($('#phTank').value, 'admin', $('#phNote').value); $('#phTank').value = ''; $('#phNote').value = ''; }
  else if (a === 'orderFor') orderForTank(id, 'admin');
  else if (a === 'remind') remind(id);
  else if (a === 'reloadDue') loadDue();
  else if (a === 'addCar') addCar();
  else if (a === 'saveCap') { const n = b.dataset.n; try { await F.updateDoc(F.doc(db, 'cars', n), { cap: num($('#cap' + n).value) || 3500 }); toast('انحفظت حمولة سيارة ' + n + '.'); } catch (x) { toast(errText(x), true); } }
  else if (a === 'findTank') findTank();
  else if (a === 'makeLogin') makeCustomerLogin(id);
  else if (a === 'makeLoginGo') makeCustomerLoginGo(id);
  else if (a === 'addTank') addTank();
  else if (a === 'saveSettings') saveSettings();
  else if (a === 'refill') refillCar(b);
  else if (a === 'duty') { S.watchId != null ? stopDuty() : startDuty(); }
  else if (a === 'saveLoc') saveLoc(id, b);
  else if (a === 'flyCar') flyCar(Number(b.dataset.n));
  else if (a === 'finish') finish(id, b);
});

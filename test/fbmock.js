// In-memory stand-in for ./fb.js, used only for local UI tests (not shipped).
const store = new Map(); // path -> data
const subs = new Set();
let user = null; const authSubs = [];
const users = { 'admin@waterapp.local': { uid: 'admin', email: 'admin@waterapp.local' } };
export const auth = {}; export const db = {};
export const ADMIN_EMAIL = 'admin@waterapp.local';
export const tankEmail = id => 't' + id + '@waterapp.local';
export const carEmail = n => 'car' + n + '@waterapp.local';
let seq = 1;
class TS { constructor(d) { this.d = d; } toDate() { return this.d; } }
export const Timestamp = { fromDate: d => new TS(d), now: () => new TS(new Date()) };
export const serverTimestamp = () => new TS(new Date());
export const doc = (_db, col, id) => ({ kind: 'doc', path: col + '/' + id, id, col });
export const collection = (_db, col) => ({ kind: 'col', col, filters: [] });
export const where = (f, op, v) => ({ t: 'w', f, op, v });
export const orderBy = f => ({ t: 'o', f }); export const limit = n => ({ t: 'l', n });
export const query = (c, ...cs) => ({ kind: 'col', col: c.col, filters: cs });
const val = v => (v instanceof TS ? v.d.getTime() : v);
function match(data, q) {
  return q.filters.every(c => {
    if (c.t !== 'w') return true; const x = data[c.f];
    if (c.op === '==') return x === c.v; if (c.op === 'in') return c.v.includes(x);
    if (c.op === '<=') return x != null && val(x) <= val(c.v); return true;
  });
}
function snapDoc(r) { const d = store.get(r.path); return { id: r.id, exists: () => !!d, data: () => (d ? { ...d } : undefined) }; }
function snapCol(q) {
  let docs = [...store.entries()].filter(([p]) => p.startsWith(q.col + '/')).map(([p, d]) => ({ id: p.split('/')[1], data: () => ({ ...d }) })).filter(x => match(x.data(), q));
  const o = q.filters.find(c => c.t === 'o'); if (o) docs.sort((a, b) => val(a.data()[o.f]) - val(b.data()[o.f]));
  const l = q.filters.find(c => c.t === 'l'); if (l) docs = docs.slice(0, l.n);
  return { docs, size: docs.length };
}
function emit() { setTimeout(() => subs.forEach(s => s.fire()), 0); }
export const getDoc = async r => snapDoc(r);
export const getDocs = async q => snapCol(q);
export const getCountFromServer = async q => ({ data: () => ({ count: snapCol(q).size }) });
export function onSnapshot(r, fn) { const s = { fire: () => fn(r.kind === 'doc' ? snapDoc(r) : snapCol(r)) }; subs.add(s); setTimeout(s.fire, 0); return () => subs.delete(s); }
export const setDoc = async (r, data, opt) => { store.set(r.path, opt && opt.merge ? { ...(store.get(r.path) || {}), ...data } : { ...data }); emit(); };
export const updateDoc = async (r, data) => { if (!store.has(r.path)) throw { code: 'not-found' }; store.set(r.path, { ...store.get(r.path), ...data }); emit(); };
export const addDoc = async (c, data) => { const id = 'd' + (seq++); store.set(c.col + '/' + id, { ...data }); emit(); return { id }; };
export const deleteDoc = async r => { store.delete(r.path); emit(); };
export function writeBatch() { const ops = []; return { set: (r, d, o) => ops.push(() => setDoc(r, d, o)), update: (r, d) => ops.push(() => updateDoc(r, d)), commit: async () => { for (const o of ops) await o(); } }; }
function setUser(u) { user = u; authSubs.forEach(f => f(u)); }
export function onAuthStateChanged(_a, fn) { authSubs.push(fn); setTimeout(() => fn(user), 0); }
export async function signInWithEmailAndPassword(_a, email, pw) { const u = users[email]; if (!u || (u.pw && u.pw !== pw)) throw { code: 'auth/invalid-credential' }; setUser(u); }
export async function createUserWithEmailAndPassword(_a, email, pw) { if (users[email]) throw { code: 'auth/email-already-in-use' }; const u = { uid: 'u' + (seq++), email, pw }; users[email] = u; setUser(u); return { user: u }; }
export async function createLogin(email, pw) { if (users[email]) throw { code: 'auth/email-already-in-use' }; const u = { uid: 'u' + (seq++), email, pw }; users[email] = u; return u.uid; }
export async function signOut() { setUser(null); }
export async function deleteUser(u) { delete users[u.email]; }
window.__mock = { store, users, login: email => setUser(users[email]) };

'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createPersistence } = require('./persistence');

const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const ADMIN_PIN = process.env.ADMIN_PIN || '5678';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json');
const IMG_DIR = process.env.IMG_DIR || path.join(path.dirname(DATA_FILE), 'images');
const persistence = createPersistence({ dataFile: DATA_FILE, imageDir: IMG_DIR });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- data
function defaultData() {
  return {
    settings: {
      shopName: 'ร้านของฉัน',
      tableCount: 30,
      requirePaymentBeforeKitchen: false,
      pickupEnabled: true,
    },
    categories: [
      { id: 'c1', name: 'กาแฟ', visible: false },
      { id: 'c2', name: 'ชา & เครื่องดื่มอื่น ๆ', visible: false },
      { id: 'c3', name: 'เบเกอรี่', visible: false },
      { id: 'c4', name: 'อาหารจานเดียว', visible: false },
      { id: 'c6', name: 'ของทานเล่น', visible: true },
      { id: 'c7', name: 'ขนม', visible: true },
      { id: 'c8', name: 'น้ำอัดลม', visible: true },
      { id: 'c5', name: 'เบียร์', visible: true },
    ],
    // เมนูตัวอย่าง — แก้/ลบได้ในหน้าแอดมิน
    items: [
      { id: 'i1', categoryId: 'c1', name: 'อเมริกาโน่เย็น', price: 55, available: true },
      { id: 'i2', categoryId: 'c1', name: 'ลาเต้ร้อน', price: 65, available: true },
      { id: 'i3', categoryId: 'c1', name: 'คาปูชิโน่เย็น', price: 70, available: true },
      { id: 'i4', categoryId: 'c2', name: 'ชาไทยเย็น', price: 50, available: true },
      { id: 'i5', categoryId: 'c2', name: 'มัทฉะลาเต้', price: 75, available: true },
      { id: 'i6', categoryId: 'c3', name: 'ครัวซองต์เนย', price: 65, available: true },
      { id: 'i7', categoryId: 'c3', name: 'ชีสเค้กบลูเบอร์รี่', price: 95, available: true },
      { id: 'i8', categoryId: 'c4', name: 'ข้าวผัดกะเพราไข่ดาว', price: 69, available: true },
      { id: 'i9', categoryId: 'c5', name: 'เบียร์ Leo กระป๋องใหญ่ 490 มล.', price: 65, available: true, stockCount: 12, defaultImage: '/images/beer-leo.jpg' },
      { id: 'i13', categoryId: 'c5', name: 'เบียร์ Leo กระป๋องเล็ก 320 มล.', price: 45, available: true, stockCount: 24, defaultImage: '/images/beer-leo-320.jpg' },
      { id: 'i10', categoryId: 'c5', name: 'เบียร์ช้าง กระป๋องยาว', price: 60, available: true, visible: false, defaultImage: '/images/beer-chang.jpg', imageScale: 1.1 },
      { id: 'i14', categoryId: 'c8', name: 'โค้กกระป๋อง', price: 20, available: true, stockCount: 24 },
      { id: 'i11', categoryId: 'c6', name: 'เฟรนช์ฟรายส์', price: 30, available: true, defaultImage: '/images/snack-fries.jpg' },
      { id: 'i12', categoryId: 'c6', name: 'ลูกชิ้นทอด (ไม้ละ)', price: 10, available: true, defaultImage: '/images/snack-meatballs.jpg' },
    ],
    orders: [],
    refunds: [], // การคืนเงิน แยกเป็นรายการ
    closes: {}, // ผลปิดร้านรายวัน key = YYYY-MM-DD
    log: [], // ใครทำอะไรเมื่อไร (เงิน/ส่งออก/ปิดร้าน)
    seq: { date: '', n: 0 },
    pickupSeq: { date: '', n: 0 },
  };
}

// ออเดอร์เก่าที่จ่ายแล้วแต่ยังไม่มีวิธีจ่าย/เวลารับเงิน (ก่อนมีฟีเจอร์บัญชี)
function migrateOrder(o) {
  if (o.paid && !o.paidAt) { o.paidAt = o.updatedAt || o.createdAt; o.paymentMethod = o.paymentMethod || 'other'; }
  if (!o.orderType) o.orderType = 'table';
  return o;
}

function normalizeData(raw) {
  try {
    const d = defaultData();
    const settings = { ...d.settings, ...(raw.settings || {}) };
    const hiddenDefaultCategories = new Set(['c1', 'c2', 'c3', 'c4']);
    const categories = (raw.categories || d.categories).map((c) => ({
      ...c,
      visible: c.visible === undefined ? !hiddenDefaultCategories.has(c.id) : c.visible,
    }));
    // เมนูร้าน: ของทานเล่น → ขนม → น้ำอัดลม → เบียร์ โดยคงลำดับหมวดอื่นไว้เหมือนเดิม
    const menuOrder = ['ของทานเล่น', 'ขนม', 'น้ำอัดลม', 'เบียร์'];
    const menuNames = new Set(menuOrder);
    const positions = categories.map((c, i) => (menuNames.has(c.name) ? i : -1)).filter((i) => i >= 0);
    if (positions.length) {
      const first = Math.min(...positions);
      const insertAt = categories.slice(0, first).filter((c) => !menuNames.has(c.name)).length;
      const ordered = menuOrder.map((name) => categories.find((c) => c.name === name)).filter(Boolean);
      const rest = categories.filter((c) => !menuNames.has(c.name));
      rest.splice(insertAt, 0, ...ordered);
      categories.splice(0, categories.length, ...rest);
    }
    const items = (raw.items || d.items).map((i) => (
      i.id === 'i10' && !i.image && i.defaultImage === '/images/beer-chang.jpg'
        && (i.imageScale === undefined || i.imageScale === 1.7)
        ? { ...i, imageScale: 1.1 }
        : i
    ));
    delete settings.promptpayId; // เลิกเก็บเลขบัญชี: ใช้ QR บัญชีร้านที่พนักงานถือแทน
    return {
      settings,
      categories,
      items,
      orders: (raw.orders || []).map(migrateOrder),
      refunds: raw.refunds || [],
      closes: raw.closes || {},
      log: raw.log || [],
      seq: raw.seq || d.seq,
      pickupSeq: raw.pickupSeq || d.pickupSeq,
    };
  } catch (e) {
    return defaultData();
  }
}

let data;
const save = () => persistence.save(data);

const uid = () => crypto.randomBytes(5).toString('hex');
const bkkDate = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const baht = (satang) => satang / 100;
function logEvent(action, orderId, detail) {
  data.log.push({ at: Date.now(), action, orderId: orderId || null, detail: detail || '' });
  if (data.log.length > 5000) data.log = data.log.slice(-5000);
}
const refundedSatang = (orderId) => data.refunds.filter((r) => r.orderId === orderId).reduce((a, r) => a + r.amountSatang, 0);

// ---------------------------------------------------------------- realtime (SSE → พนักงาน)
const sseClients = new Set();
function broadcast(type, orderId) {
  const msg = `event: change\ndata: ${JSON.stringify({ type, orderId })}\n\n`;
  for (const res of sseClients) res.write(msg);
}
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000);

// ---------------------------------------------------------------- auth (PIN พนักงาน)
const sessions = new Map(); // token -> { expires, role }
const loginFails = new Map(); // ip -> {n, until}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionOf(req) {
  const t = parseCookies(req).staff;
  const s = t && sessions.get(t);
  return s && s.expires > Date.now() ? s : null;
}
function isStaff(req) {
  const s = sessionOf(req);
  return !!(s && (s.role === 'staff' || s.role === 'admin'));
}
function isAdmin(req) {
  const s = sessionOf(req);
  return !!(s && s.role === 'admin');
}
function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'admin_required' });
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// รูปเมนู (ชื่อไฟล์สุ่มและเปลี่ยนทุกครั้งที่อัปโหลด จึงแคชได้นาน)
app.get('/img/:file', asyncRoute(async (req, res) => {
  if (!/^[a-f0-9]{10}\.jpg$/.test(req.params.file)) return res.status(404).end();
  try {
    const image = await persistence.getImage(req.params.file);
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'image/jpeg' });
    res.send(image);
  } catch (error) {
    res.status(404).end();
  }
}));

const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/t/:table', page('customer.html'));
app.get('/pickup', page('customer.html'));
app.get('/pos', page('pos.html'));
app.get('/kitchen', page('kitchen.html'));
app.get('/admin', page('admin.html'));
app.get('/login', page('login.html'));

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// ---- login
app.post('/api/login', (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  const expectedPin = role === 'admin' ? ADMIN_PIN : STAFF_PIN;
  const ip = req.ip;
  const failKey = `${ip}:${role}`;
  const f = loginFails.get(failKey);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'ลองผิดหลายครั้ง รอสักครู่แล้วลองใหม่' });
  if (!safeEqual(req.body.pin || '', expectedPin)) {
    const n = (f ? f.n : 0) + 1;
    loginFails.set(failKey, { n, until: n >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
  }
  loginFails.delete(failKey);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { expires: Date.now() + 12 * 3600 * 1000, role });
  res.setHeader(
    'Set-Cookie',
    `staff=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}${req.secure ? '; Secure' : ''}`
  );
  res.json({ ok: true, role });
});
app.get('/api/me', (req, res) => {
  const s = sessionOf(req);
  res.json({ staff: !!s, role: s ? s.role : null });
});

// ---- เมนู (สาธารณะ)
app.get('/api/menu', (req, res) => {
  const s = data.settings;
  const categories = data.categories.filter((c) => c.visible !== false);
  const visibleCategoryIds = new Set(categories.map((c) => c.id));
  res.json({
    shopName: s.shopName,
    tableCount: s.tableCount,
    pickupEnabled: s.pickupEnabled !== false,
    categories,
    items: data.items
      .filter((i) => visibleCategoryIds.has(i.categoryId) && i.visible !== false)
      .map((i) => ({ ...i, available: i.available && (i.stockCount === null || i.stockCount === undefined || i.stockCount > 0) })),
  });
});

// ---- ลูกค้าสั่งอาหาร
const lastOrderAt = {};
function publicOrder(o) {
  return {
    id: o.id, seq: o.seq, orderType: o.orderType || 'table', table: o.table,
    customerName: o.customerName || null, queueNo: o.queueNo || null, items: o.items,
    total: baht(o.totalSatang), status: o.status, paid: o.paid, createdAt: o.createdAt,
    paymentMethod: o.paid ? o.paymentMethod || 'other' : null,
    paidAt: o.paid ? o.paidAt || null : null,
    refunded: baht(refundedSatang(o.id)),
  };
}

app.post('/api/orders', asyncRoute(async (req, res) => {
  const orderType = req.body.orderType === 'pickup' ? 'pickup' : 'table';
  const table = orderType === 'table' ? parseInt(req.body.table, 10) : null;
  let customerName = null;
  if (orderType === 'table' && !(table >= 1 && table <= data.settings.tableCount))
    return res.status(400).json({ error: 'เลขโต๊ะไม่ถูกต้อง' });
  if (orderType === 'pickup') {
    if (data.settings.pickupEnabled === false) return res.status(409).json({ error: 'ร้านปิดรับออเดอร์รับเองชั่วคราว' });
    customerName = String(req.body.customerName || '').trim().replace(/\s+/g, ' ');
    if (!customerName || customerName.length > 30) return res.status(400).json({ error: 'กรุณากรอกชื่อสำหรับเรียกคิว (ไม่เกิน 30 ตัวอักษร)' });
  }

  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (!lines.length || lines.length > 30) return res.status(400).json({ error: 'ตะกร้าว่างหรือมีรายการมากเกินไป' });

  const now = Date.now();
  // ลูกค้าหลายคนอาจใช้ Wi-Fi ร้านและมี IP เดียวกัน จึงแยกคีย์รับเองด้วยชื่อเรียกคิวด้วย
  const rateKey = orderType === 'table' ? `table:${table}` : `pickup:${req.ip}:${customerName.toLowerCase()}`;
  if (lastOrderAt[rateKey] && now - lastOrderAt[rateKey] < 3000)
    return res.status(429).json({ error: 'กดซ้ำเร็วเกินไป รอสักครู่' });

  // กันคนนอกสั่งป่วน: ถ้าโต๊ะนี้มีรอบที่ยังไม่จ่ายค้างหลายรอบ ให้จ่ายก่อน
  if (orderType === 'table') {
    const unpaid = data.orders.filter(
      (o) => o.table === table && !o.paid && o.status !== 'cancelled' && now - o.createdAt < 6 * 3600 * 1000
    ).length;
    if (unpaid >= 3)
      return res.status(429).json({ error: 'โต๊ะนี้มีรอบที่ยังไม่ชำระหลายรอบ กรุณาชำระหรือเรียกพนักงาน' });
  }

  const items = [];
  let totalSatang = 0;
  const stockNeeded = new Map();
  for (const l of lines) {
    const it = data.items.find((x) => x.id === l.itemId);
    const qty = parseInt(l.qty, 10);
    if (!it || !it.available || it.visible === false) return res.status(400).json({ error: 'มีเมนูที่หมด ซ่อนอยู่ หรือไม่พบ กรุณารีเฟรชหน้า' });
    if (!(qty >= 1 && qty <= 20)) return res.status(400).json({ error: 'จำนวนไม่ถูกต้อง' });
    const needed = (stockNeeded.get(it.id) || 0) + qty;
    if (Number.isInteger(it.stockCount) && needed > it.stockCount)
      return res.status(409).json({ error: `${it.name} เหลือเพียง ${it.stockCount} ชิ้น` });
    stockNeeded.set(it.id, needed);
    const priceSatang = Math.round(it.price * 100); // ราคาใช้จากเซิร์ฟเวอร์เสมอ ไม่เชื่อฝั่งลูกค้า
    totalSatang += priceSatang * qty;
    items.push({ itemId: it.id, name: it.name, price: it.price, qty, note: String(l.note || '').slice(0, 100) });
  }

  const today = bkkDate();
  if (data.seq.date !== today) data.seq = { date: today, n: 0 };
  data.seq.n += 1;
  let queueNo = null;
  if (orderType === 'pickup') {
    if (data.pickupSeq.date !== today) data.pickupSeq = { date: today, n: 0 };
    data.pickupSeq.n += 1;
    queueNo = `A${String(data.pickupSeq.n).padStart(3, '0')}`;
  }

  const order = {
    id: uid(), seq: data.seq.n, orderType, table, customerName, queueNo, items, totalSatang,
    status: 'new', paid: false, createdAt: now, updatedAt: now,
  };
  for (const [itemId, qty] of stockNeeded) {
    const item = data.items.find((x) => x.id === itemId);
    if (Number.isInteger(item.stockCount)) item.stockCount -= qty;
  }
  data.orders.push(order);
  lastOrderAt[rateKey] = now;
  try { await save(); } catch (error) {
    data.orders = data.orders.filter((x) => x.id !== order.id);
    for (const [itemId, qty] of stockNeeded) {
      const item = data.items.find((x) => x.id === itemId);
      if (Number.isInteger(item.stockCount)) item.stockCount += qty;
    }
    throw error;
  }
  broadcast('new', order.id);
  res.json(publicOrder(order));
}));

app.get('/api/orders/:id', (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  res.json(publicOrder(o));
});

// ---------------------------------------------------------------- staff API
const staff = express.Router();
staff.use(requireStaff);

staff.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

staff.get('/orders', (req, res) => {
  const since = Date.now() - 12 * 3600 * 1000;
  const list = data.orders.filter((o) => o.createdAt >= since).map(publicOrder);
  res.json({ orders: list, requirePaymentBeforeKitchen: data.settings.requirePaymentBeforeKitchen, shopName: data.settings.shopName });
});

staff.post('/orders/:id/status', asyncRoute(async (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const st = req.body.status;
  if (!['new', 'cooking', 'ready', 'served', 'cancelled'].includes(st)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  if (st === 'ready' && !['pickup', 'pos'].includes(o.orderType || 'table'))
    return res.status(400).json({ error: 'สถานะพร้อมรับใช้กับออเดอร์รับเองหรือ POS เท่านั้น' });
  if (st === 'cooking' && data.settings.requirePaymentBeforeKitchen && !o.paid)
    return res.status(409).json({ error: 'ตั้งค่าไว้ให้ชำระก่อนเริ่มทำ' });
  // เงินต้องตามรอยได้: ออเดอร์ที่รับเงินแล้วจะยกเลิกได้ก็ต่อเมื่อบันทึกการคืนเงินครบแล้ว
  if (st === 'cancelled' && o.paid && refundedSatang(o.id) < o.totalSatang)
    return res.status(409).json({ error: 'ออเดอร์นี้รับเงินแล้ว กรุณากด "คืนเงิน" และบันทึกให้ครบยอดก่อนจึงจะยกเลิกได้' });
  if (o.status === 'cancelled' && st !== 'cancelled')
    return res.status(409).json({ error: 'ออเดอร์ที่ยกเลิกแล้วเปิดกลับไม่ได้ กรุณาสร้างออเดอร์ใหม่' });
  if (st === 'cancelled' && o.status !== 'cancelled') logEvent('cancel', o.id, '');
  if (st === 'cancelled' && o.status !== 'cancelled' && !o.stockRestored) {
    for (const line of o.items) {
      const item = line.itemId && data.items.find((x) => x.id === line.itemId);
      if (item && Number.isInteger(item.stockCount)) item.stockCount += line.qty;
    }
    o.stockRestored = true;
  }
  o.status = st;
  o.updatedAt = Date.now();
  await save();
  broadcast('status', o.id);
  res.json(publicOrder(o));
}));

// ---- รับเงิน (บันทึกวิธีจ่ายและเวลา) / ยกเลิกการรับเงิน
const METHODS = ['promptpay', 'cash', 'other'];
const METHOD_TH = { promptpay: 'PromptPay', cash: 'เงินสด', other: 'อื่น ๆ' };

// ---- POS หน้าเคาน์เตอร์: พนักงานบันทึกการขายและรับเงินในครั้งเดียว
staff.post('/pos/orders', asyncRoute(async (req, res) => {
  const method = req.body.method || 'promptpay';
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'วิธีจ่ายไม่ถูกต้อง' });
  const fulfillment = req.body.fulfillment === 'prepare' ? 'prepare' : 'immediate';
  const customerName = String(req.body.customerName || '').trim().replace(/\s+/g, ' ').slice(0, 30) || null;
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (!lines.length || lines.length > 30) return res.status(400).json({ error: 'ตะกร้าว่างหรือมีรายการมากเกินไป' });

  const items = [];
  let totalSatang = 0;
  const stockNeeded = new Map();
  for (const line of lines) {
    const item = data.items.find((x) => x.id === line.itemId);
    const qty = parseInt(line.qty, 10);
    if (!item || !item.available || item.visible === false) return res.status(400).json({ error: 'มีเมนูที่หมด ซ่อนอยู่ หรือไม่พบ กรุณารีเฟรชหน้า' });
    if (!(qty >= 1 && qty <= 20)) return res.status(400).json({ error: 'จำนวนไม่ถูกต้อง' });
    const needed = (stockNeeded.get(item.id) || 0) + qty;
    if (Number.isInteger(item.stockCount) && needed > item.stockCount)
      return res.status(409).json({ error: `${item.name} เหลือเพียง ${item.stockCount} ชิ้น` });
    stockNeeded.set(item.id, needed);
    const priceSatang = Math.round(item.price * 100);
    totalSatang += priceSatang * qty;
    items.push({ itemId: item.id, name: item.name, price: item.price, qty, note: '' });
  }

  const now = Date.now(), today = bkkDate(now);
  if (data.seq.date !== today) data.seq = { date: today, n: 0 };
  if (data.pickupSeq.date !== today) data.pickupSeq = { date: today, n: 0 };
  data.seq.n += 1;
  data.pickupSeq.n += 1;
  const order = {
    id: uid(), seq: data.seq.n, orderType: 'pos', table: null, customerName,
    queueNo: `A${String(data.pickupSeq.n).padStart(3, '0')}`,
    items, totalSatang, status: fulfillment === 'prepare' ? 'cooking' : 'served',
    paid: true, paymentMethod: method, paidAt: now, createdAt: now, updatedAt: now,
  };
  for (const [itemId, qty] of stockNeeded) {
    const item = data.items.find((x) => x.id === itemId);
    if (Number.isInteger(item.stockCount)) item.stockCount -= qty;
  }
  data.orders.push(order);
  logEvent('paid', order.id, `${method} pos`);
  try { await save(); } catch (error) {
    data.orders = data.orders.filter((x) => x.id !== order.id);
    for (const [itemId, qty] of stockNeeded) {
      const item = data.items.find((x) => x.id === itemId);
      if (Number.isInteger(item.stockCount)) item.stockCount += qty;
    }
    throw error;
  }
  broadcast('new', order.id);
  res.json(publicOrder(order));
}));

staff.post('/orders/:id/paid', asyncRoute(async (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (req.body.paid) {
    const method = req.body.method === undefined ? 'promptpay' : req.body.method;
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'วิธีจ่ายไม่ถูกต้อง' });
    if (o.status === 'cancelled') return res.status(409).json({ error: 'ออเดอร์ที่ยกเลิกแล้วรับเงินไม่ได้' });
    if (!o.paid) { // กดซ้ำไม่เขียนทับเวลาและวิธีจ่ายเดิม
      o.paid = true; o.paymentMethod = method; o.paidAt = Date.now();
      logEvent('paid', o.id, method);
    }
  } else {
    if (refundedSatang(o.id) > 0) return res.status(409).json({ error: 'ออเดอร์นี้มีการคืนเงินแล้ว ยกเลิกการรับเงินไม่ได้' });
    if (o.paid) logEvent('unpaid', o.id, o.paymentMethod || '');
    o.paid = false; delete o.paymentMethod; delete o.paidAt;
  }
  o.updatedAt = Date.now();
  await save();
  broadcast('paid', o.id);
  res.json(publicOrder(o));
}));

// ---- คืนเงิน (บันทึกเป็นรายการ ไม่ซ่อนในสถานะยกเลิก)
staff.post('/orders/:id/refund', asyncRoute(async (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (!o.paid) return res.status(409).json({ error: 'ออเดอร์นี้ยังไม่ได้รับเงิน คืนเงินไม่ได้' });
  const amountSatang = Math.round(Number(req.body.amount) * 100);
  if (!(amountSatang > 0)) return res.status(400).json({ error: 'ยอดคืนไม่ถูกต้อง' });
  const method = req.body.method === undefined ? o.paymentMethod || 'other' : req.body.method;
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'วิธีคืนเงินไม่ถูกต้อง' });
  const reason = String(req.body.reason || '').trim().slice(0, 100);
  if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการคืนเงิน' });
  if (amountSatang > o.totalSatang - refundedSatang(o.id))
    return res.status(400).json({ error: 'ยอดคืนเกินยอดที่ลูกค้าจ่ายไว้' });
  data.refunds.push({ id: uid(), orderId: o.id, amountSatang, method, reason, at: Date.now() });
  logEvent('refund', o.id, `${baht(amountSatang)} ${method}`);
  o.updatedAt = Date.now();
  await save();
  broadcast('paid', o.id);
  res.json(publicOrder(o));
}));

// ---------------------------------------------------------------- บัญชี / รายงาน
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(s + 'T00:00:00Z').getTime();
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; // กัน 2026-02-31 ที่ JS ปัดให้เอง
};
const emptyMethods = () => Object.fromEntries(METHODS.map((m) => [m, { count: 0, satang: 0 }]));
const methodOf = (m) => (METHODS.includes(m) ? m : 'other');

// รายงานของ 1 วัน: นับยอดรับตามวันที่ "รับเงิน" (paidAt) และยอดคืนตามวันที่คืน
function dayReport(date) {
  const receipts = emptyMethods(), refunds = emptyMethods();
  for (const o of data.orders)
    if (o.paid && o.paidAt && bkkDate(o.paidAt) === date) {
      const m = receipts[methodOf(o.paymentMethod)]; m.count++; m.satang += o.totalSatang;
    }
  for (const r of data.refunds)
    if (bkkDate(r.at) === date) { const m = refunds[methodOf(r.method)]; m.count++; m.satang += r.amountSatang; }
  const net = {}, sum = (x) => Object.values(x).reduce((a, v) => a + v.satang, 0);
  for (const m of METHODS) net[m] = receipts[m].satang - refunds[m].satang;
  const cancelledUnpaid = data.orders.filter((o) => bkkDate(o.createdAt) === date && o.status === 'cancelled' && !o.paid);
  const openUnpaid = data.orders
    .filter((o) => bkkDate(o.createdAt) === date && !o.paid && o.status !== 'cancelled')
    .map((o) => ({
      seq: o.seq, orderType: o.orderType || 'table', table: o.table,
      customerName: o.customerName || null, queueNo: o.queueNo || null,
      total: baht(o.totalSatang), status: o.status, createdAt: o.createdAt,
    }));
  const c = data.closes[date];
  return {
    date, methods: METHODS.map((m) => ({
      method: m, label: METHOD_TH[m],
      receiptCount: receipts[m].count, receipts: baht(receipts[m].satang),
      refundCount: refunds[m].count, refunds: baht(refunds[m].satang), net: baht(net[m]),
    })),
    totals: { receipts: baht(sum(receipts)), refunds: baht(sum(refunds)), net: baht(sum(receipts) - sum(refunds)) },
    cancelled: { count: cancelledUnpaid.length, total: baht(cancelledUnpaid.reduce((a, o) => a + o.totalSatang, 0)) },
    openUnpaid,
    close: c ? { bankTotal: baht(c.bankTotalSatang), countedCash: baht(c.countedCashSatang), note: c.note, closedAt: c.closedAt, edits: (c.history || []).length } : null,
  };
}

staff.get('/report', requireAdmin, (req, res) => {
  const date = req.query.date || bkkDate();
  if (!isDate(date)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
  res.json(dayReport(date));
});

staff.post('/close', requireAdmin, asyncRoute(async (req, res) => {
  const date = req.body.date;
  if (!isDate(date)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
  if (date > bkkDate()) return res.status(400).json({ error: 'ปิดร้านล่วงหน้าไม่ได้' });
  const bank = Number(req.body.bankTotal), cash = Number(req.body.countedCash);
  if (!(bank >= 0 && bank <= 1e8 && cash >= 0 && cash <= 1e8)) return res.status(400).json({ error: 'ยอดเงินไม่ถูกต้อง' });
  const prev = data.closes[date];
  data.closes[date] = {
    bankTotalSatang: Math.round(bank * 100), countedCashSatang: Math.round(cash * 100),
    note: String(req.body.note || '').trim().slice(0, 200), closedAt: Date.now(),
    history: prev ? [...(prev.history || []), { bankTotalSatang: prev.bankTotalSatang, countedCashSatang: prev.countedCashSatang, note: prev.note, closedAt: prev.closedAt }] : [],
  };
  logEvent(prev ? 'close-edit' : 'close', null, date); // แก้ผลปิดร้านเก่าได้ แต่เก็บประวัติไว้เสมอ
  await save();
  res.json(dayReport(date));
}));

function readRange(req, res) {
  const from = req.query.from, to = req.query.to;
  if (!isDate(from) || !isDate(to) || from > to) { res.status(400).json({ error: 'ช่วงวันที่ไม่ถูกต้อง' }); return null; }
  if ((new Date(to) - new Date(from)) / 86400000 > 92) { res.status(400).json({ error: 'เลือกช่วงได้ไม่เกิน 93 วัน' }); return null; }
  return { from, to };
}
const inRange = (d, r) => d >= r.from && d <= r.to;

staff.get('/report/range', requireAdmin, (req, res) => {
  const r = readRange(req, res); if (!r) return;
  const days = {};
  const day = (d) => (days[d] = days[d] || { date: d, orders: 0, receipts: 0, refunds: 0 });
  const items = {};
  for (const o of data.orders) {
    if (!o.paid || !o.paidAt) continue;
    const d = bkkDate(o.paidAt);
    if (!inRange(d, r)) continue;
    const x = day(d); x.orders++; x.receipts += o.totalSatang;
    if (o.status !== 'cancelled') for (const it of o.items) {
      const k = it.name; items[k] = items[k] || { name: k, qty: 0, satang: 0 };
      items[k].qty += it.qty; items[k].satang += Math.round(it.price * 100) * it.qty;
    }
  }
  for (const f of data.refunds) { const d = bkkDate(f.at); if (inRange(d, r)) day(d).refunds += f.amountSatang; }
  const rows = Object.values(days).sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((x) => ({ date: x.date, orders: x.orders, receipts: baht(x.receipts), refunds: baht(x.refunds), net: baht(x.receipts - x.refunds) }));
  const tot = rows.reduce((a, x) => ({ orders: a.orders + x.orders, receipts: a.receipts + x.receipts * 100, refunds: a.refunds + x.refunds * 100 }), { orders: 0, receipts: 0, refunds: 0 });
  res.json({
    from: r.from, to: r.to, rows,
    totals: { orders: tot.orders, receipts: Math.round(tot.receipts) / 100, refunds: Math.round(tot.refunds) / 100, net: Math.round(tot.receipts - tot.refunds) / 100 },
    topItems: Object.values(items).sort((a, b) => b.satang - a.satang).slice(0, 20).map((i) => ({ name: i.name, qty: i.qty, total: baht(i.satang) })),
  });
});

// ---- ส่งออก CSV (เปิดใน Excel ภาษาไทยได้: UTF-8 + BOM)
function csvCell(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // กันสูตรแฝงใน Excel จากข้อความที่ลูกค้าพิมพ์ (เช่น หมายเหตุ)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const bkkTime = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
const orderNo = (o) => `${bkkDate(o.createdAt)}-${o.seq}`;
const STATUS_TH = { new: 'รอรับออเดอร์', cooking: 'กำลังจัดเตรียม', ready: 'พร้อมรับ', served: 'ส่งมอบแล้ว', cancelled: 'ยกเลิก' };

staff.get('/export/:kind', requireAdmin, asyncRoute(async (req, res) => {
  const r = readRange(req, res); if (!r) return;
  const kind = req.params.kind;
  // ออเดอร์ที่นับเข้าช่วง = วันที่รับเงิน (ถ้ายังไม่จ่ายใช้วันที่สั่ง)
  const orders = data.orders.filter((o) => inRange(bkkDate(o.paid && o.paidAt ? o.paidAt : o.createdAt), r))
    .sort((a, b) => a.createdAt - b.createdAt);
  let header, rows;
  if (kind === 'orders') {
    header = ['เลขที่ออเดอร์', 'วันเวลาที่สั่ง', 'ประเภท', 'โต๊ะ/คิว', 'ชื่อลูกค้า', 'สถานะ', 'ยอด(บาท)', 'จ่ายแล้ว', 'วิธีจ่าย', 'วันเวลารับเงิน', 'คืนเงินรวม(บาท)'];
    rows = orders.map((o) => [orderNo(o), bkkTime(o.createdAt), (o.orderType || 'table') === 'pickup' ? 'รับเอง' : o.orderType === 'pos' ? 'POS หน้าร้าน' : 'โต๊ะ',
      ['pickup', 'pos'].includes(o.orderType) ? o.queueNo || '' : o.table, o.customerName || '', STATUS_TH[o.status] || o.status, baht(o.totalSatang).toFixed(2),
      o.paid ? 'ใช่' : 'ไม่', o.paid ? METHOD_TH[methodOf(o.paymentMethod)] : '', o.paid && o.paidAt ? bkkTime(o.paidAt) : '', baht(refundedSatang(o.id)).toFixed(2)]);
  } else if (kind === 'order_items') {
    header = ['เลขที่ออเดอร์', 'สถานะออเดอร์', 'ชื่อเมนู', 'ราคาต่อหน่วย(บาท)', 'จำนวน', 'รวม(บาท)', 'หมายเหตุ'];
    rows = orders.flatMap((o) => o.items.map((i) => [orderNo(o), STATUS_TH[o.status] || o.status, i.name, Number(i.price).toFixed(2), i.qty, (Math.round(i.price * 100) * i.qty / 100).toFixed(2), i.note || '']));
  } else if (kind === 'refunds') {
    header = ['เลขที่ออเดอร์', 'ยอดคืน(บาท)', 'วิธีคืน', 'เหตุผล', 'วันเวลาที่คืน'];
    rows = data.refunds.filter((f) => inRange(bkkDate(f.at), r)).sort((a, b) => a.at - b.at).map((f) => {
      const o = data.orders.find((x) => x.id === f.orderId);
      return [o ? orderNo(o) : '-', baht(f.amountSatang).toFixed(2), METHOD_TH[methodOf(f.method)], f.reason, bkkTime(f.at)];
    });
  } else return res.status(404).json({ error: 'not found' });
  logEvent('export', null, `${kind} ${r.from}..${r.to}`);
  await save();
  const body = '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${kind}_${r.from}_${r.to}.csv"` });
  res.send(body);
}));

// สรุปวันนี้ (ใช้นิยามเดียวกับรายงานปิดร้าน จะได้ตัวเลขตรงกันทุกหน้า)
staff.get('/summary', requireAdmin, (req, res) => res.json(dayReport(bkkDate())));

// ---- เมนู / หมวด / ตั้งค่า
staff.get('/config', requireAdmin, (req, res) => {
  res.json({
    settings: data.settings, categories: data.categories, items: data.items, baseUrl: baseUrl(req),
    defaultStaffPin: STAFF_PIN === '1234', defaultAdminPin: ADMIN_PIN === '5678',
  });
});

staff.put('/settings', requireAdmin, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const s = data.settings;
  if (b.shopName !== undefined) {
    const v = String(b.shopName).trim();
    if (!v || v.length > 50) return res.status(400).json({ error: 'ชื่อร้านไม่ถูกต้อง' });
    s.shopName = v;
  }
  if (b.tableCount !== undefined) {
    const v = parseInt(b.tableCount, 10);
    if (!(v >= 1 && v <= 200)) return res.status(400).json({ error: 'จำนวนโต๊ะต้อง 1-200' });
    s.tableCount = v;
  }
  if (b.requirePaymentBeforeKitchen !== undefined) s.requirePaymentBeforeKitchen = !!b.requirePaymentBeforeKitchen;
  if (b.pickupEnabled !== undefined) s.pickupEnabled = !!b.pickupEnabled;
  await save();
  res.json(s);
}));

staff.post('/categories', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'ชื่อหมวดไม่ถูกต้อง' });
  const c = { id: uid(), name, visible: true };
  data.categories.push(c);
  await save();
  res.json(c);
}));
staff.put('/categories/:id', requireAdmin, asyncRoute(async (req, res) => {
  const c = data.categories.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 40) return res.status(400).json({ error: 'ชื่อหมวดไม่ถูกต้อง' });
    c.name = name;
  }
  if (req.body.visible !== undefined) c.visible = !!req.body.visible;
  await save();
  res.json(c);
}));
staff.delete('/categories/:id', requireAdmin, asyncRoute(async (req, res) => {
  if (data.items.some((i) => i.categoryId === req.params.id))
    return res.status(409).json({ error: 'ลบเมนูในหมวดนี้ออกก่อน' });
  data.categories = data.categories.filter((c) => c.id !== req.params.id);
  await save();
  res.json({ ok: true });
}));

function readItem(b) {
  const name = String(b.name || '').trim();
  const price = Number(b.price);
  if (!name || name.length > 60) return { error: 'ชื่อเมนูไม่ถูกต้อง' };
  if (!(price >= 0 && price <= 100000)) return { error: 'ราคาไม่ถูกต้อง' };
  if (!data.categories.some((c) => c.id === b.categoryId)) return { error: 'ไม่พบหมวด' };
  const stockCount = b.stockCount === '' || b.stockCount === null || b.stockCount === undefined
    ? null : Number(b.stockCount);
  if (stockCount !== null && (!Number.isInteger(stockCount) || stockCount < 0 || stockCount > 1000000))
    return { error: 'จำนวนสต็อกต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 1,000,000' };
  return { value: {
    name, price: Math.round(price * 100) / 100, categoryId: b.categoryId,
    available: b.available !== false, visible: b.visible !== false, stockCount,
  } };
}
staff.post('/items', requireAdmin, asyncRoute(async (req, res) => {
  const r = readItem(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const it = { id: uid(), ...r.value };
  data.items.push(it);
  await save();
  res.json(it);
}));
staff.put('/items/:id', requireAdmin, asyncRoute(async (req, res) => {
  const it = data.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const r = readItem({ ...it, ...req.body });
  if (r.error) return res.status(400).json({ error: r.error });
  Object.assign(it, r.value);
  await save();
  res.json(it);
}));
staff.delete('/items/:id', requireAdmin, asyncRoute(async (req, res) => {
  const it = data.items.find((i) => i.id === req.params.id);
  data.items = data.items.filter((i) => i.id !== req.params.id);
  await save();
  if (it && it.image) persistence.removeImage(it.image).catch(console.error);
  res.json({ ok: true });
}));

// ---- รูปเมนู: เบราว์เซอร์ย่อรูปเป็น JPEG ก่อนส่ง เซิร์ฟเวอร์ตรวจซ้ำทุกอย่าง ไม่เชื่อฝั่งเบราว์เซอร์
const MAX_IMG_BYTES = 600 * 1024;
const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
staff.put('/items/:id/image', requireAdmin, express.raw({ type: 'image/jpeg', limit: MAX_IMG_BYTES + 1 }), asyncRoute(async (req, res) => {
  const it = data.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !isJpeg(buf)) return res.status(400).json({ error: 'ไฟล์ต้องเป็นรูป JPEG' });
  if (buf.length > MAX_IMG_BYTES) return res.status(413).json({ error: 'รูปใหญ่เกินไป (ไม่เกิน 600KB)' });
  const name = `${uid()}.jpg`; // ชื่อใหม่ทุกครั้ง เบราว์เซอร์จึงไม่ค้างรูปเก่า
  const previous = it.image;
  await persistence.putImage(name, buf);
  it.image = name;
  try {
    await save();
  } catch (error) {
    if (previous) it.image = previous; else delete it.image;
    persistence.removeImage(name).catch(console.error);
    throw error;
  }
  if (previous) persistence.removeImage(previous).catch(console.error);
  res.json(it);
}));
staff.delete('/items/:id/image', requireAdmin, asyncRoute(async (req, res) => {
  const it = data.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  const previous = it.image;
  delete it.image;
  await save();
  if (previous) persistence.removeImage(previous).catch(console.error);
  res.json(it);
}));

// QR ประจำโต๊ะ
staff.get('/tableqr/:n', requireAdmin, async (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (!(n >= 1 && n <= data.settings.tableCount)) return res.status(400).end();
  const buf = await QRCode.toBuffer(`${baseUrl(req)}/t/${n}`, { width: 600, margin: 2 });
  res.type('png').send(buf);
});
staff.get('/pickupqr', requireAdmin, async (req, res) => {
  const buf = await QRCode.toBuffer(`${baseUrl(req)}/pickup`, { width: 600, margin: 2 });
  res.type('png').send(buf);
});

app.use('/api/staff', staff);

// ข้อผิดพลาดทั้งหมดตอบเป็น JSON (เช่น รูปใหญ่เกิน, JSON พัง)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'ไฟล์ใหญ่เกินไป' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
});

async function start() {
  data = normalizeData(await persistence.load(defaultData()));
  await save(); // บันทึก migration และสร้าง singleton row ในการเปิดครั้งแรก
  app.listen(PORT, () => {
    console.log(`เปิดใช้งานที่ http://localhost:${PORT}`);
    console.log(`  POS: /pos    รับออเดอร์: /kitchen    หน้าแอดมิน: /admin    หน้าลูกค้า: /t/1`);
    console.log(`  ที่เก็บข้อมูล: ${persistence.remote ? 'Supabase' : DATA_FILE}`);
    if (STAFF_PIN === '1234') console.log('⚠️  ยังใช้ PIN เริ่มต้น 1234 — ตั้งค่าใหม่ด้วย STAFF_PIN=xxxx ก่อนใช้งานจริง');
    if (ADMIN_PIN === '5678') console.log('⚠️  ยังใช้ PIN แอดมินเริ่มต้น 5678 — ตั้งค่าใหม่ด้วย ADMIN_PIN=xxxx');
    if (STAFF_PIN === ADMIN_PIN) console.log('⚠️  STAFF_PIN และ ADMIN_PIN ต้องไม่ซ้ำกันก่อนใช้งานจริง');
  });
}

start().catch((error) => {
  console.error('เริ่มระบบไม่สำเร็จ:', error);
  process.exit(1);
});

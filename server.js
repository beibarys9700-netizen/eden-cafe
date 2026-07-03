const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_BODY = 10 * 1024 * 1024;
let ADMIN_PIN = '2026';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const sessions = new Map();
const rateLimit = new Map();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    bookings: [],
    orders: [],
    gallery: [],
    content: {
      phone1: '+7 (707) 945-78-87',
      phone2: '+7 (778) 829-47-14',
      address: 'мкр. Достык, ул. Поль Гурдэ, 17',
      hours_weekday: 'Пн–Чт, Вс: 09:00–23:00',
      hours_friday: 'Пт–Сб: 09:00–00:00',
      instagram: '@eden.almaty',
      instagramUrl: 'https://instagram.com/eden.almaty',
      whatsapp: '+77079457887',
      telegram: '+77079457887',
      heroText: 'Кухня мира в стенах одного места',
      heroEye: 'Мультикультурная кухня · 100% Halal · Алматы',
      halal: true,
      seats: 600,
      vipRooms: 5,
      floors: 2
    },
    reviews: [
      { name: 'Maira Maira', text: 'Добрый день! Я сегодня заказала салаты, баурсаки, хлебную корзину. Всё так вкусно, рахмет вам большое. Приветствие с дверей администратора на высоте.', date: '13 июня 2026', source: '2GIS', rating: 5 },
      { name: 'Серик А. & Simpatikus', text: 'Очень уютно красиво и вкусно у вас. Обстановка уютная. Всем кто хочет очень вкусно покушать — рекомендую, не пожалеете.', date: '12 июня 2026', source: '2GIS · 97 отзывов', rating: 5 },
      { name: 'Акмарал Боранова', text: 'Здесь очень вкусно, хорошая атмосфера, вкусная кухня, шашлыки супер!', date: '29 мая 2026', source: '2GIS · подтверждённый', rating: 5 }
    ],
    popularDishes: [7, 11, 8, 12, 14, 15, 23, 24]
  }, null, 2));
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { bookings: [], orders: [], gallery: [], content: {}, reviews: [], popularDishes: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.gif': 'image/gif', '.woff2': 'font/woff2'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function sendJSON(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const isText = mime.startsWith('text/') || mime.includes('javascript') || mime.includes('json');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': mime + (isText ? '; charset=utf-8' : ''),
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(data);
  });
}

function readBody(req, cb) {
  let body = '';
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); cb(null); return; }
    body += c;
  });
  req.on('end', () => cb(body));
}

function sanitizeStr(s) {
  return typeof s === 'string' ? s.replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;'
  })[c] || c) : '';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60000;
  const max = 60;
  if (!rateLimit.has(ip)) rateLimit.set(ip, []);
  const hits = rateLimit.get(ip).filter(t => now - t < window);
  hits.push(now);
  rateLimit.set(ip, hits);
  return hits.length <= max;
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(c => {
    const [key, val] = c.trim().split('=');
    if (key) cookies[key] = val;
  });
  return cookies;
}

function isAdmin(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['eden_session'];
  return sessionId && sessions.has(sessionId);
}

function readMultipart(req, cb) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) { cb(null); return; }
  const boundary = boundaryMatch[1];
  const chunks = [];
  let size = 0;

  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); cb(null); return; }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const boundaryBuf = Buffer.from('--' + boundary);
    const result = { fields: {}, file: null };

    let pos = 0;
    while (pos < buffer.length) {
      const start = buffer.indexOf(boundaryBuf, pos);
      if (start === -1) break;
      const nextStart = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
      if (nextStart === -1) break;

      const part = buffer.slice(start + boundaryBuf.length, nextStart);
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) { pos = nextStart; continue; }

      const headers = part.slice(0, headerEnd).toString();
      const body = part.slice(headerEnd + 4, part.length - 2);

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);

      if (filenameMatch && nameMatch) {
        const ext = path.extname(filenameMatch[1]).toLowerCase() || '.jpg';
        const safeName = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
        const filePath = path.join(UPLOADS_DIR, safeName);
        fs.writeFileSync(filePath, body);
        result.file = { fieldName: nameMatch[1], filename: safeName, originalName: filenameMatch[1], path: filePath };
      } else if (nameMatch) {
        result.fields[nameMatch[1]] = body.toString('utf8');
      }
      pos = nextStart;
    }
    cb(result);
  });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (!checkRateLimit(ip)) {
    sendJSON(res, 429, { ok: false, error: 'Слишком много запросов' });
    return;
  }

  const url = new URL(req.url, 'http://' + req.headers.host);

  // ========== AUTH ==========
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const { pin } = JSON.parse(body);
        if (pin === ADMIN_PIN) {
          const sessionId = generateSessionId();
          sessions.set(sessionId, { created: Date.now() });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `eden_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          sendJSON(res, 401, { ok: false, error: 'Неверный PIN-код' });
        }
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    const sid = cookies['eden_session'];
    if (sid) sessions.delete(sid);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'eden_session=; Path=/; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/auth/check' && req.method === 'GET') {
    sendJSON(res, 200, { ok: true, auth: isAdmin(req) });
    return;
  }

  // ========== PIN CHANGE ==========
  if (url.pathname === '/api/auth/change-pin' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    readBody(req, body => {
      try {
        const { currentPin, newPin } = JSON.parse(body);
        if (currentPin !== ADMIN_PIN) { sendJSON(res, 400, { ok: false, error: 'Неверный текущий PIN' }); return; }
        if (!newPin || newPin.length < 4 || newPin.length > 8) { sendJSON(res, 400, { ok: false, error: 'PIN должен быть 4-8 цифр' }); return; }
        if (!/^\d+$/.test(newPin)) { sendJSON(res, 400, { ok: false, error: 'PIN должен содержать только цифры' }); return; }
        ADMIN_PIN = newPin;
        sessions.clear();
        sendJSON(res, 200, { ok: true });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  // ========== BOOKINGS (public read, auth write) ==========
  if (url.pathname === '/api/bookings' && req.method === 'GET') {
    const db = readDB();
    sendJSON(res, 200, { ok: true, bookings: db.bookings || [] });
    return;
  }

  if (url.pathname === '/api/bookings' && req.method === 'POST') {
    readBody(req, body => {
      if (!body) { sendJSON(res, 400, { ok: false, error: 'Пустой запрос' }); return; }
      try {
        const b = JSON.parse(body);
        if (!b.name || !b.phone || !b.date || !b.time || !b.tableId || !b.floor) {
          sendJSON(res, 400, { ok: false, error: 'Заполните все обязательные поля' }); return;
        }
        b.id = 'EDN-' + Math.floor(1000 + Math.random() * 9000);
        b.timestamp = Date.now();
        b.name = sanitizeStr(b.name);
        b.phone = sanitizeStr(b.phone);
        b.wish = sanitizeStr(b.wish || '');
        const db = readDB();
        const conflict = (db.bookings || []).find(x =>
          x.floor === b.floor && x.tableId === b.tableId && x.date === b.date && x.time === b.time
        );
        if (conflict) { sendJSON(res, 409, { ok: false, error: 'Стол уже забронирован на это время' }); return; }
        if (!db.bookings) db.bookings = [];
        db.bookings.push(b);
        writeDB(db);
        sendJSON(res, 201, { ok: true, booking: b });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  if (url.pathname.startsWith('/api/bookings/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    const db = readDB();
    const idx = (db.bookings || []).findIndex(b => b.id === id);
    if (idx === -1) { sendJSON(res, 404, { ok: false, error: 'Не найдено' }); return; }
    db.bookings.splice(idx, 1);
    writeDB(db);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ========== ORDERS ==========
  if (url.pathname === '/api/orders' && req.method === 'GET') {
    const db = readDB();
    sendJSON(res, 200, { ok: true, orders: db.orders || [] });
    return;
  }

  if (url.pathname === '/api/orders' && req.method === 'POST') {
    readBody(req, body => {
      if (!body) { sendJSON(res, 400, { ok: false, error: 'Пустой запрос' }); return; }
      try {
        const order = JSON.parse(body);
        if (!order.items || !order.total) { sendJSON(res, 400, { ok: false, error: 'Неверный заказ' }); return; }
        order.id = 'EDN-O-' + Math.floor(1000 + Math.random() * 9000);
        order.date = new Date().toISOString();
        const db = readDB();
        if (!db.orders) db.orders = [];
        db.orders.push(order);
        writeDB(db);
        sendJSON(res, 201, { ok: true, order });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  // ========== GALLERY ==========
  if (url.pathname === '/api/gallery' && req.method === 'GET') {
    const db = readDB();
    sendJSON(res, 200, { ok: true, gallery: db.gallery || [] });
    return;
  }

  if (url.pathname === '/api/gallery' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    readMultipart(req, result => {
      if (!result || !result.file) { sendJSON(res, 400, { ok: false, error: 'Файл не загружен' }); return; }
      const db = readDB();
      if (!db.gallery) db.gallery = [];
      const item = {
        id: 'gal-' + Date.now(),
        src: '/uploads/' + result.file.filename,
        label: result.fields.label || '',
        order: db.gallery.length,
        createdAt: new Date().toISOString()
      };
      db.gallery.push(item);
      writeDB(db);
      sendJSON(res, 201, { ok: true, item });
    });
    return;
  }

  if (url.pathname.startsWith('/api/gallery/') && req.method === 'DELETE') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    const id = url.pathname.split('/').pop();
    const db = readDB();
    const idx = (db.gallery || []).findIndex(g => g.id === id);
    if (idx === -1) { sendJSON(res, 404, { ok: false, error: 'Не найдено' }); return; }
    const item = db.gallery[idx];
    if (item.src && item.src.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, item.src);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    db.gallery.splice(idx, 1);
    writeDB(db);
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/api/gallery/') && req.method === 'PUT') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    const id = url.pathname.split('/').pop();
    readBody(req, body => {
      try {
        const updates = JSON.parse(body);
        const db = readDB();
        const item = (db.gallery || []).find(g => g.id === id);
        if (!item) { sendJSON(res, 404, { ok: false, error: 'Не найдено' }); return; }
        if (updates.label !== undefined) item.label = sanitizeStr(updates.label);
        if (updates.order !== undefined) item.order = updates.order;
        writeDB(db);
        sendJSON(res, 200, { ok: true, item });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  // ========== CONTENT ==========
  if (url.pathname === '/api/content' && req.method === 'GET') {
    const db = readDB();
    sendJSON(res, 200, { ok: true, content: db.content || {} });
    return;
  }

  if (url.pathname === '/api/content' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    readBody(req, body => {
      try {
        const updates = JSON.parse(body);
        const db = readDB();
        db.content = { ...(db.content || {}), ...updates };
        writeDB(db);
        sendJSON(res, 200, { ok: true, content: db.content });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  // ========== REVIEWS ==========
  if (url.pathname === '/api/reviews' && req.method === 'GET') {
    const db = readDB();
    sendJSON(res, 200, { ok: true, reviews: db.reviews || [] });
    return;
  }

  if (url.pathname === '/api/reviews' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    readBody(req, body => {
      try {
        const review = JSON.parse(body);
        review.id = 'rev-' + Date.now();
        review.date = review.date || new Date().toLocaleDateString('ru-RU');
        review.rating = review.rating || 5;
        const db = readDB();
        if (!db.reviews) db.reviews = [];
        db.reviews.push(review);
        writeDB(db);
        sendJSON(res, 201, { ok: true, review });
      } catch (e) { sendJSON(res, 400, { ok: false, error: 'Неверные данные' }); }
    });
    return;
  }

  if (url.pathname.startsWith('/api/reviews/') && req.method === 'DELETE') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    const id = url.pathname.split('/').pop();
    const db = readDB();
    const idx = (db.reviews || []).findIndex(r => r.id === id);
    if (idx === -1) { sendJSON(res, 404, { ok: false, error: 'Не найдено' }); return; }
    db.reviews.splice(idx, 1);
    writeDB(db);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ========== FILE UPLOAD (for menu photos) ==========
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    readMultipart(req, result => {
      if (!result || !result.file) { sendJSON(res, 400, { ok: false, error: 'Файл не загружен' }); return; }
      sendJSON(res, 201, { ok: true, url: '/uploads/' + result.file.filename });
    });
    return;
  }

  // ========== EXPORT ==========
  if (url.pathname === '/api/export' && req.method === 'GET') {
    if (!isAdmin(req)) { sendJSON(res, 401, { ok: false, error: 'Требуется авторизация' }); return; }
    const db = readDB();
    sendJSON(res, 200, { ok: true, data: db, exportDate: new Date().toISOString() });
    return;
  }

  // ========== STATIC FILES ==========
  const safePath = url.pathname.replace(/\.\./g, '');
  let filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);
  sendFile(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('EDEN server running at http://localhost:' + PORT);
  console.log('Network: http://' + getIP() + ':' + PORT);
});

function getIP() {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

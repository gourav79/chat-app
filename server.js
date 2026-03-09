const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

const streamsByUser = new Map();

function ensureDb() {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], invites: [], chats: [], messages: [] }, null, 2));
  }
}
function readDb() { ensureDb(); return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
const nextId = (items) => (items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1);

function sendJson(res, code, payload, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').filter(Boolean).map((p) => {
    const [k, ...v] = p.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, packed) {
  const [salt, original] = (packed || '').split(':');
  if (!salt || !original) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(original));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (expected !== sig) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function auth(req) {
  const cookies = parseCookies(req);
  const authHeader = req.headers.authorization?.replace('Bearer ', '');
  return verifyToken(authHeader || cookies.token);
}

function pushEvent(userIds, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  userIds.forEach((id) => {
    const set = streamsByUser.get(id);
    if (!set) return;
    set.forEach((res) => res.write(msg));
  });
}

function getMime(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.js')) return 'application/javascript';
  return 'text/plain';
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const { email, password } = await parseBody(req);
    if (!email || !password || password.length < 6) return sendJson(res, 400, { error: 'Email and password (min 6 chars) are required' });
    if (db.users.some((u) => u.email === String(email).toLowerCase())) return sendJson(res, 409, { error: 'Email already registered' });
    const user = { id: nextId(db.users), email: String(email).toLowerCase(), passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user); writeDb(db);
    const token = signToken({ userId: user.id, email: user.email });
    return sendJson(res, 200, { token, user: { id: user.id, email: user.email } }, { 'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax` });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email, password } = await parseBody(req);
    const user = db.users.find((u) => u.email === String(email).toLowerCase());
    if (!user || !verifyPassword(password || '', user.passwordHash)) return sendJson(res, 401, { error: 'Invalid credentials' });
    const token = signToken({ userId: user.id, email: user.email });
    return sendJson(res, 200, { token, user: { id: user.id, email: user.email } }, { 'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax` });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
  }

  const user = auth(req);
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
    return sendJson(res, 200, { user: { id: user.userId, email: user.email } });
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const streamUser = verifyToken(url.searchParams.get('token'));
    if (!streamUser) return sendJson(res, 401, { error: 'Unauthorized' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: ready\ndata: {}\n\n');
    const set = streamsByUser.get(streamUser.userId) || new Set();
    set.add(res); streamsByUser.set(streamUser.userId, set);
    req.on('close', () => { set.delete(res); if (!set.size) streamsByUser.delete(streamUser.userId); });
    return;
  }

  if (!user && url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Unauthorized' });

  if (req.method === 'POST' && url.pathname === '/api/invites') {
    const token = crypto.randomBytes(12).toString('hex');
    const invite = { id: nextId(db.invites), token, createdBy: user.userId, status: 'pending', usedBy: null, createdAt: new Date().toISOString() };
    db.invites.push(invite); writeDb(db);
    return sendJson(res, 200, { invite, link: `${url.origin}/invite/${token}` });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/invites/')) {
    const token = url.pathname.split('/')[3];
    const invite = db.invites.find((i) => i.token === token && i.status === 'pending');
    if (!invite) return sendJson(res, 404, { error: 'Invite is invalid or already used' });
    const inviter = db.users.find((u) => u.id === invite.createdBy);
    return sendJson(res, 200, { invite: { token: invite.token, inviterEmail: inviter?.email } });
  }

  if (req.method === 'POST' && /\/api\/invites\/.+\/accept/.test(url.pathname)) {
    const token = url.pathname.split('/')[3];
    const invite = db.invites.find((i) => i.token === token && i.status === 'pending');
    if (!invite) return sendJson(res, 404, { error: 'Invite is invalid or already used' });
    if (invite.createdBy === user.userId) return sendJson(res, 400, { error: 'You cannot accept your own invite' });
    let chat = db.chats.find((c) => c.members.length === 2 && c.members.includes(invite.createdBy) && c.members.includes(user.userId));
    if (!chat) {
      chat = { id: nextId(db.chats), type: 'direct', members: [invite.createdBy, user.userId], createdAt: new Date().toISOString() };
      db.chats.push(chat);
    }
    invite.status = 'accepted'; invite.usedBy = user.userId; invite.acceptedAt = new Date().toISOString();
    writeDb(db);
    return sendJson(res, 200, { chatId: chat.id });
  }

  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const chats = db.chats.filter((c) => c.members.includes(user.userId)).map((chat) => {
      const otherId = chat.members.find((m) => m !== user.userId);
      const other = db.users.find((u) => u.id === otherId);
      const lastMessage = [...db.messages].filter((m) => m.chatId === chat.id).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
      return { id: chat.id, otherUser: other ? { id: other.id, email: other.email } : null, lastMessage };
    });
    return sendJson(res, 200, { chats });
  }

  if (req.method === 'GET' && /\/api\/chats\/.+\/messages/.test(url.pathname)) {
    const chatId = Number(url.pathname.split('/')[3]);
    const chat = db.chats.find((c) => c.id === chatId && c.members.includes(user.userId));
    if (!chat) return sendJson(res, 404, { error: 'Chat not found' });
    const messages = db.messages.filter((m) => m.chatId === chatId).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
    return sendJson(res, 200, { messages });
  }

  if (req.method === 'POST' && /\/api\/chats\/.+\/messages/.test(url.pathname)) {
    const chatId = Number(url.pathname.split('/')[3]);
    const chat = db.chats.find((c) => c.id === chatId && c.members.includes(user.userId));
    const { content } = await parseBody(req);
    if (!chat) return sendJson(res, 404, { error: 'Chat not found' });
    if (!content || !String(content).trim()) return sendJson(res, 400, { error: 'Message content required' });
    const message = { id: nextId(db.messages), chatId, senderId: user.userId, content: String(content), createdAt: new Date().toISOString() };
    db.messages.push(message); writeDb(db);
    pushEvent(chat.members, 'message:new', message);
    return sendJson(res, 200, { message });
  }

  const routeToIndex = url.pathname === '/' || /^\/invite\//.test(url.pathname) || /^\/chat\//.test(url.pathname);
  const filePath = routeToIndex ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
    res.writeHead(200, { 'Content-Type': getMime(normalized) });
    fs.createReadStream(normalized).pipe(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => handler(req, res).catch((e) => sendJson(res, 500, { error: e.message }))).listen(PORT, () => {
  console.log(`Chat app running on http://localhost:${PORT}`);
});

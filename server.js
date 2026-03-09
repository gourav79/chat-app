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
const MAX_CHANNEL_MEMBERS = 8; // inviter + up to 7 invitees

const streamsByUser = new Map();

function ensureDb() {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], channels: [], invites: [], messages: [] }, null, 2));
  }
}
function readDb() {
  ensureDb();
  const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!parsed.channels) parsed.channels = [];
  if (!parsed.invites) parsed.invites = [];
  if (!parsed.messages) parsed.messages = [];
  if (!parsed.users) parsed.users = [];
  return parsed;
}
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
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 30 * 86400000 })).toString('base64url');
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

function channelPendingInvites(db, channelId) {
  return db.invites.filter((i) => i.channelId === channelId && i.status === 'pending').length;
}

function channelSummary(db, channel, viewerId) {
  const members = channel.members.map((id) => {
    const u = db.users.find((x) => x.id === id);
    return u ? { id: u.id, email: u.email } : null;
  }).filter(Boolean);

  const lastMessage = [...db.messages].filter((m) => m.channelId === channel.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  return {
    id: channel.id,
    name: channel.name,
    ownerId: channel.ownerId,
    isOwner: channel.ownerId === viewerId,
    memberCount: channel.members.length,
    members,
    slotsLeft: MAX_CHANNEL_MEMBERS - channel.members.length,
    pendingInvites: channelPendingInvites(db, channel.id),
    lastMessage,
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const { email, password } = await parseBody(req);
    if (!email || !password || password.length < 6) return sendJson(res, 400, { error: 'Email and password (min 6 chars) are required' });
    const normalized = String(email).toLowerCase().trim();
    if (db.users.some((u) => u.email === normalized)) return sendJson(res, 409, { error: 'Email already registered' });
    const user = { id: nextId(db.users), email: normalized, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user);
    writeDb(db);
    const token = signToken({ userId: user.id, email: user.email });
    return sendJson(res, 200, { token, user: { id: user.id, email: user.email } }, { 'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email, password } = await parseBody(req);
    const normalized = String(email || '').toLowerCase().trim();
    const user = db.users.find((u) => u.email === normalized);
    if (!user || !verifyPassword(password || '', user.passwordHash)) return sendJson(res, 401, { error: 'Invalid credentials' });
    const token = signToken({ userId: user.id, email: user.email });
    return sendJson(res, 200, { token, user: { id: user.id, email: user.email } }, { 'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
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
    set.add(res);
    streamsByUser.set(streamUser.userId, set);
    req.on('close', () => {
      set.delete(res);
      if (!set.size) streamsByUser.delete(streamUser.userId);
    });
    return;
  }

  if (!user && url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Unauthorized' });

  if (req.method === 'POST' && url.pathname === '/api/channels') {
    const { name } = await parseBody(req);
    const channelName = String(name || '').trim() || 'Untitled Channel';
    const channel = {
      id: nextId(db.channels),
      name: channelName,
      ownerId: user.userId,
      members: [user.userId],
      createdAt: new Date().toISOString(),
    };
    db.channels.push(channel);
    writeDb(db);
    return sendJson(res, 200, { channel: channelSummary(db, channel, user.userId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/channels') {
    const channels = db.channels
      .filter((c) => c.members.includes(user.userId))
      .map((c) => channelSummary(db, c, user.userId));
    return sendJson(res, 200, { channels });
  }

  if (req.method === 'POST' && /^\/api\/channels\/\d+\/invites$/.test(url.pathname)) {
    const channelId = Number(url.pathname.split('/')[3]);
    const channel = db.channels.find((c) => c.id === channelId);
    if (!channel || !channel.members.includes(user.userId)) return sendJson(res, 404, { error: 'Channel not found' });
    const { email } = await parseBody(req);
    const inviteEmail = String(email || '').toLowerCase().trim();
    if (!inviteEmail || !inviteEmail.includes('@')) return sendJson(res, 400, { error: 'Valid email is required' });

    const slotsLeft = MAX_CHANNEL_MEMBERS - channel.members.length;
    const pending = channelPendingInvites(db, channelId);
    if (slotsLeft - pending <= 0) {
      return sendJson(res, 400, { error: 'Channel has reached member/invite limit (max 8 members)' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const invite = {
      id: nextId(db.invites),
      token,
      channelId,
      channelName: channel.name,
      createdBy: user.userId,
      email: inviteEmail,
      status: 'pending',
      usedBy: null,
      createdAt: new Date().toISOString(),
    };
    db.invites.push(invite);
    writeDb(db);

    const link = `${url.origin}/invite/${token}`;
    const mailto = `mailto:${encodeURIComponent(inviteEmail)}?subject=${encodeURIComponent(`Join my channel: ${channel.name}`)}&body=${encodeURIComponent(`You are invited to join ${channel.name}. Open this link and login: ${link}`)}`;

    return sendJson(res, 200, { invite, link, mailto });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/invites/')) {
    const token = url.pathname.split('/')[3];
    const invite = db.invites.find((i) => i.token === token);
    if (!invite || invite.status !== 'pending') return sendJson(res, 404, { error: 'Invite is invalid or already used' });
    const channel = db.channels.find((c) => c.id === invite.channelId);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    return sendJson(res, 200, {
      invite: {
        token: invite.token,
        channelId: invite.channelId,
        channelName: invite.channelName,
        email: invite.email,
        slotsLeft: MAX_CHANNEL_MEMBERS - channel.members.length,
      },
    });
  }

  if (req.method === 'POST' && /^\/api\/invites\/.+\/accept$/.test(url.pathname)) {
    const token = url.pathname.split('/')[3];
    const invite = db.invites.find((i) => i.token === token);
    if (!invite || invite.status !== 'pending') return sendJson(res, 404, { error: 'Invite is invalid or already used' });

    if (invite.email !== user.email) {
      return sendJson(res, 403, { error: `This invite is for ${invite.email}. Login with that email.` });
    }

    const channel = db.channels.find((c) => c.id === invite.channelId);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.members.includes(user.userId)) return sendJson(res, 400, { error: 'You are already in this channel' });
    if (channel.members.length >= MAX_CHANNEL_MEMBERS) return sendJson(res, 400, { error: 'Channel is full (max 8 members)' });

    channel.members.push(user.userId);
    invite.status = 'accepted';
    invite.usedBy = user.userId;
    invite.acceptedAt = new Date().toISOString();
    writeDb(db);

    pushEvent(channel.members, 'channel:updated', { channelId: channel.id });
    return sendJson(res, 200, { channelId: channel.id });
  }

  if (req.method === 'GET' && /^\/api\/channels\/\d+\/messages$/.test(url.pathname)) {
    const channelId = Number(url.pathname.split('/')[3]);
    const channel = db.channels.find((c) => c.id === channelId && c.members.includes(user.userId));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    const messages = db.messages.filter((m) => m.channelId === channelId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return sendJson(res, 200, { messages });
  }

  if (req.method === 'POST' && /^\/api\/channels\/\d+\/messages$/.test(url.pathname)) {
    const channelId = Number(url.pathname.split('/')[3]);
    const channel = db.channels.find((c) => c.id === channelId && c.members.includes(user.userId));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const { content } = await parseBody(req);
    if (!content || !String(content).trim()) return sendJson(res, 400, { error: 'Message content required' });

    const message = {
      id: nextId(db.messages),
      channelId,
      senderId: user.userId,
      senderEmail: user.email,
      content: String(content).trim(),
      createdAt: new Date().toISOString(),
    };
    db.messages.push(message);
    writeDb(db);

    pushEvent(channel.members, 'message:new', message);
    return sendJson(res, 200, { message });
  }

  const routeToIndex = url.pathname === '/' || /^\/invite\//.test(url.pathname);
  const filePath = routeToIndex ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
    res.writeHead(200, { 'Content-Type': getMime(normalized) });
    fs.createReadStream(normalized).pipe(res);
    return;
  }

  return sendJson(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => handler(req, res).catch((e) => sendJson(res, 500, { error: e.message })))
  .listen(PORT, () => {
    console.log(`Chat app running on http://localhost:${PORT}`);
  });

const app = document.getElementById('app');
let state = { token: localStorage.getItem('token'), user: null, chats: [], activeChatId: null, inviteToken: null };
let stream;

function pathInviteToken() {
  const match = location.pathname.match(/^\/invite\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderAuth(mode = 'login', error = '') {
  app.innerHTML = `<div class="card"><h2>${mode === 'login' ? 'Login' : 'Sign Up'}</h2><input id="email" type="email" placeholder="Email" /><input id="password" type="password" placeholder="Password (min 6 chars)" /><button id="submit">${mode === 'login' ? 'Login' : 'Create Account'}</button><button id="switch" class="secondary">${mode === 'login' ? 'Need an account? Sign up' : 'Already have account? Login'}</button>${error ? `<small class="error">${error}</small>` : ''}</div>`;
  document.getElementById('switch').onclick = () => renderAuth(mode === 'login' ? 'signup' : 'login');
  document.getElementById('submit').onclick = async () => {
    try {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
      state.token = data.token;
      localStorage.setItem('token', state.token);
      await boot();
    } catch (e) { renderAuth(mode, e.message); }
  };
}

function initStream() {
  if (stream) stream.close();
  stream = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  stream.addEventListener('message:new', async () => {
    await loadChats();
    if (state.activeChatId) await renderMessages();
  });
}

async function loadChats() {
  const data = await api('/api/chats');
  state.chats = data.chats;
  if (!state.activeChatId && state.chats[0]) state.activeChatId = state.chats[0].id;
  renderChatLayout();
}

async function handleInviteFlow() {
  if (!state.inviteToken) return;
  try {
    await api(`/api/invites/${state.inviteToken}`);
    const accepted = await api(`/api/invites/${state.inviteToken}/accept`, { method: 'POST' });
    history.replaceState({}, '', '/');
    state.inviteToken = null;
    state.activeChatId = accepted.chatId;
  } catch (e) {
    alert(`Invite issue: ${e.message}`);
    history.replaceState({}, '', '/');
    state.inviteToken = null;
  }
}

function renderChatLayout() {
  app.innerHTML = `<div class="layout"><aside class="sidebar"><div><strong>${state.user.email}</strong></div><button id="inviteBtn">Invite Friend</button><button id="logout" class="secondary">Logout</button><div id="inviteLink"></div><div id="chatList"></div></aside><section class="chat"><div class="header" id="chatHeader">Select a chat</div><div class="messages" id="messages"></div><div class="composer"><textarea id="msgInput" rows="2" placeholder="Type a message"></textarea><button id="sendBtn">Send</button></div></section></div>`;

  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('token');
    if (stream) stream.close();
    state = { token: null, user: null, chats: [], activeChatId: null, inviteToken: null };
    renderAuth();
  };

  document.getElementById('inviteBtn').onclick = async () => {
    const data = await api('/api/invites', { method: 'POST' });
    document.getElementById('inviteLink').innerHTML = `<div class="linkbox">Share this link:<br>${data.link}</div>`;
  };

  document.getElementById('sendBtn').onclick = async () => {
    const text = document.getElementById('msgInput').value.trim();
    if (!text || !state.activeChatId) return;
    await api(`/api/chats/${state.activeChatId}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
    document.getElementById('msgInput').value = '';
    await renderMessages();
  };

  const list = document.getElementById('chatList');
  list.innerHTML = '';
  state.chats.forEach((chat) => {
    const item = document.createElement('div');
    item.className = `chat-item ${chat.id === state.activeChatId ? 'active' : ''}`;
    item.innerHTML = `<div>${chat.otherUser?.email || 'Unknown'}</div><div class="meta">${chat.lastMessage?.content || 'No messages yet'}</div>`;
    item.onclick = async () => { state.activeChatId = chat.id; renderChatLayout(); await renderMessages(); };
    list.appendChild(item);
  });
  renderMessages();
}

async function renderMessages() {
  const messagesNode = document.getElementById('messages');
  const header = document.getElementById('chatHeader');
  if (!messagesNode || !header) return;
  if (!state.activeChatId) { header.textContent = 'No active chat'; messagesNode.innerHTML = '<p class="meta">Create an invite and start chatting.</p>'; return; }
  const chat = state.chats.find((c) => c.id === state.activeChatId);
  header.textContent = chat?.otherUser?.email || 'Chat';
  const data = await api(`/api/chats/${state.activeChatId}/messages`);
  messagesNode.innerHTML = data.messages.map((m) => `<div class="msg ${m.senderId === state.user.id ? 'me' : ''}">${m.content}<div class="meta">${new Date(m.createdAt).toLocaleTimeString()}</div></div>`).join('');
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

async function boot() {
  state.inviteToken = pathInviteToken();
  if (!state.token) return renderAuth('login');
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    initStream();
    await handleInviteFlow();
    await loadChats();
  } catch {
    localStorage.removeItem('token');
    state.token = null;
    renderAuth('login');
  }
}

boot();

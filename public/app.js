const app = document.getElementById('app');
let state = {
  token: localStorage.getItem('token'),
  user: null,
  channels: [],
  activeChannelId: null,
  inviteToken: null,
};
let stream;

const inviteTokenFromPath = () => (location.pathname.match(/^\/invite\/([a-z0-9]+)/i) || [])[1] || null;

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderAuth(mode = 'login', error = '') {
  app.innerHTML = `
    <div class="card">
      <h2>${mode === 'login' ? 'Login' : 'Sign Up'}</h2>
      <input id="email" type="email" placeholder="Email" />
      <input id="password" type="password" placeholder="Password (min 6 chars)" />
      <button id="submit">${mode === 'login' ? 'Login' : 'Create Account'}</button>
      <button id="switch" class="secondary">${mode === 'login' ? 'Need an account? Sign up' : 'Already have account? Login'}</button>
      ${error ? `<small class="error">${error}</small>` : ''}
    </div>`;

  document.getElementById('switch').onclick = () => renderAuth(mode === 'login' ? 'signup' : 'login');
  document.getElementById('submit').onclick = async () => {
    try {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
      state.token = data.token;
      localStorage.setItem('token', state.token);
      await boot();
    } catch (e) {
      renderAuth(mode, e.message);
    }
  };
}

function initStream() {
  if (stream) stream.close();
  stream = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  stream.addEventListener('message:new', async () => {
    await loadChannels();
    await renderMessages();
  });
  stream.addEventListener('channel:updated', async () => {
    await loadChannels();
  });
}

async function loadChannels() {
  const { channels } = await api('/api/channels');
  state.channels = channels;
  if (!state.activeChannelId && channels[0]) state.activeChannelId = channels[0].id;
  renderChatLayout();
}

async function handleInviteFlow() {
  if (!state.inviteToken) return;
  try {
    const preview = await api(`/api/invites/${state.inviteToken}`);
    const ok = confirm(`Join channel "${preview.invite.channelName}" as ${state.user.email}?`);
    if (!ok) return;
    const accepted = await api(`/api/invites/${state.inviteToken}/accept`, { method: 'POST' });
    state.activeChannelId = accepted.channelId;
    history.replaceState({}, '', '/');
    state.inviteToken = null;
  } catch (e) {
    alert(`Invite issue: ${e.message}`);
    history.replaceState({}, '', '/');
    state.inviteToken = null;
  }
}

function renderChatLayout() {
  app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div><strong>${state.user.email}</strong></div>
      <div class="stack">
        <input id="channelName" placeholder="New channel name" />
        <button id="createChannel">Create Channel</button>
      </div>
      <button id="logout" class="secondary">Logout</button>
      <div id="channelList"></div>
    </aside>
    <section class="chat">
      <div class="header" id="channelHeader">Select a channel</div>
      <div class="invite-panel" id="invitePanel"></div>
      <div class="messages" id="messages"></div>
      <div class="composer">
        <textarea id="msgInput" rows="2" placeholder="Type a message"></textarea>
        <button id="sendBtn">Send</button>
      </div>
    </section>
  </div>`;

  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('token');
    if (stream) stream.close();
    state = { token: null, user: null, channels: [], activeChannelId: null, inviteToken: null };
    renderAuth('login');
  };

  document.getElementById('createChannel').onclick = async () => {
    const name = document.getElementById('channelName').value.trim();
    await api('/api/channels', { method: 'POST', body: JSON.stringify({ name }) });
    document.getElementById('channelName').value = '';
    await loadChannels();
  };

  document.getElementById('sendBtn').onclick = async () => {
    const text = document.getElementById('msgInput').value.trim();
    if (!text || !state.activeChannelId) return;
    await api(`/api/channels/${state.activeChannelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: text }),
    });
    document.getElementById('msgInput').value = '';
    await renderMessages();
  };

  const list = document.getElementById('channelList');
  list.innerHTML = '';
  state.channels.forEach((channel) => {
    const item = document.createElement('div');
    item.className = `chat-item ${channel.id === state.activeChannelId ? 'active' : ''}`;
    item.innerHTML = `<div>${channel.name}</div><div class="meta">Members: ${channel.memberCount}/8</div>`;
    item.onclick = async () => {
      state.activeChannelId = channel.id;
      renderChatLayout();
      await renderMessages();
    };
    list.appendChild(item);
  });

  renderInvitePanel();
  renderMessages();
}

function renderInvitePanel() {
  const panel = document.getElementById('invitePanel');
  if (!panel) return;
  const channel = state.channels.find((c) => c.id === state.activeChannelId);
  if (!channel) {
    panel.innerHTML = '<div class="meta">Create a channel to invite friends.</div>';
    return;
  }

  panel.innerHTML = `
    <div class="meta"><strong>${channel.name}</strong> • ${channel.memberCount}/8 members • ${channel.slotsLeft} slots left</div>
    <div class="row">
      <input id="inviteEmail" type="email" placeholder="Friend email for invite" ${channel.slotsLeft <= channel.pendingInvites ? 'disabled' : ''} />
      <button id="inviteBtn" ${channel.slotsLeft <= channel.pendingInvites ? 'disabled' : ''}>Invite</button>
    </div>
    <div id="inviteResult"></div>
  `;

  const inviteBtn = document.getElementById('inviteBtn');
  if (inviteBtn) {
    inviteBtn.onclick = async () => {
      try {
        const email = document.getElementById('inviteEmail').value.trim();
        const data = await api(`/api/channels/${channel.id}/invites`, {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        document.getElementById('inviteResult').innerHTML = `
          <div class="linkbox">Invite link: ${data.link}</div>
          <a href="${data.mailto}">Open mail app for ${data.invite.email}</a>
        `;
        await loadChannels();
      } catch (e) {
        document.getElementById('inviteResult').innerHTML = `<small class="error">${e.message}</small>`;
      }
    };
  }
}

async function renderMessages() {
  const messagesNode = document.getElementById('messages');
  const header = document.getElementById('channelHeader');
  if (!messagesNode || !header) return;

  if (!state.activeChannelId) {
    header.textContent = 'No active channel';
    messagesNode.innerHTML = '<p class="meta">Create a channel and invite up to 7 people.</p>';
    return;
  }

  const channel = state.channels.find((c) => c.id === state.activeChannelId);
  header.textContent = channel ? `${channel.name} (${channel.memberCount}/8)` : 'Channel';

  const data = await api(`/api/channels/${state.activeChannelId}/messages`);
  messagesNode.innerHTML = data.messages
    .map((m) => `<div class="msg ${m.senderId === state.user.id ? 'me' : ''}">
      <div>${m.content}</div>
      <div class="meta">${m.senderEmail} • ${new Date(m.createdAt).toLocaleTimeString()}</div>
    </div>`)
    .join('');
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

async function boot() {
  state.inviteToken = inviteTokenFromPath();
  if (!state.token) return renderAuth('login');
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    initStream();
    await handleInviteFlow();
    await loadChannels();
  } catch {
    localStorage.removeItem('token');
    state.token = null;
    renderAuth('login');
  }
}

boot();

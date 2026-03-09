const chats = [
  {
    id: 1,
    name: 'Alex Turner',
    status: 'last seen today at 10:42',
    messages: [
      { fromMe: false, text: 'Hey! Are we still on for tonight?', time: '10:31' },
      { fromMe: true, text: 'Yes 🙌 See you at 8.', time: '10:33' },
    ],
  },
  {
    id: 2,
    name: 'Design Team',
    status: '5 participants',
    messages: [
      { fromMe: false, text: 'Pushed the new onboarding mocks.', time: '09:21' },
      { fromMe: true, text: 'Great, I will review after standup.', time: '09:26' },
      { fromMe: false, text: 'Perfect.', time: '09:28' },
    ],
  },
  {
    id: 3,
    name: 'Mom ❤️',
    status: 'online',
    messages: [
      { fromMe: false, text: 'Did you eat lunch?', time: '12:10' },
      { fromMe: true, text: 'Just did 😄', time: '12:11' },
    ],
  },
];

const ui = {
  contactList: document.querySelector('#contactList'),
  activeAvatar: document.querySelector('#activeAvatar'),
  activeName: document.querySelector('#activeName'),
  activeStatus: document.querySelector('#activeStatus'),
  messageList: document.querySelector('#messageList'),
  messageForm: document.querySelector('#messageForm'),
  messageInput: document.querySelector('#messageInput'),
  searchInput: document.querySelector('#searchInput'),
};

let activeChatId = chats[0].id;

const initialsFromName = (name) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const lastMessagePreview = (chat) => chat.messages[chat.messages.length - 1]?.text ?? '';

function renderContacts(filter = '') {
  const value = filter.trim().toLowerCase();

  ui.contactList.innerHTML = chats
    .filter((chat) => chat.name.toLowerCase().includes(value))
    .map((chat) => {
      const activeClass = chat.id === activeChatId ? 'active' : '';
      return `
        <button class="contact ${activeClass}" data-id="${chat.id}">
          <div class="avatar">${initialsFromName(chat.name)}</div>
          <div>
            <h2>${chat.name}</h2>
            <p>${lastMessagePreview(chat)}</p>
          </div>
          <small class="subtle">${chat.messages[chat.messages.length - 1]?.time ?? ''}</small>
        </button>`;
    })
    .join('');
}

function renderActiveChat() {
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  if (!activeChat) return;

  ui.activeAvatar.textContent = initialsFromName(activeChat.name);
  ui.activeName.textContent = activeChat.name;
  ui.activeStatus.textContent = activeChat.status;

  ui.messageList.innerHTML = activeChat.messages
    .map(
      (message) => `
      <article class="message ${message.fromMe ? 'sent' : 'received'}">
        ${message.text}
        <span>${message.time}</span>
      </article>`
    )
    .join('');

  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

ui.contactList.addEventListener('click', (event) => {
  const button = event.target.closest('.contact');
  if (!button) return;

  activeChatId = Number(button.dataset.id);
  renderContacts(ui.searchInput.value);
  renderActiveChat();
});

ui.messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.messageInput.value.trim();
  if (!text) return;

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  if (!activeChat) return;

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  activeChat.messages.push({ fromMe: true, text, time });
  ui.messageInput.value = '';

  renderContacts(ui.searchInput.value);
  renderActiveChat();
});

ui.searchInput.addEventListener('input', () => {
  renderContacts(ui.searchInput.value);
});

renderContacts();
renderActiveChat();

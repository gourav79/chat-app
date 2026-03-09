# Browser Chat App (WhatsApp Web-style MVP)

This project implements a browser chat MVP with:
- Email/password signup and login
- Invite-by-link flow
- Auth-required invite acceptance
- 1-to-1 real-time chat updates via Server-Sent Events (SSE)

## Run

```bash
npm start
```

Open http://localhost:3000

## User flow

1. Sign up or log in.
2. Click **Invite Friend** and share the generated link.
3. Friend opens link, logs in/signs up, and invite is accepted automatically.
4. Both users can chat in the created direct chat.

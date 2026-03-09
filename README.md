# Browser Chat App (Channel Invite MVP)

A browser chat app with:
- Email/password signup + login
- Persistent JWT auto-login (stored token)
- Multiple private channels per user
- Invite-by-email link flow for channels
- Invitee must login with invited email before joining
- Max 8 users per channel (inviter + up to 7 invitees)

## Run

```bash
npm start
```

Then open: http://localhost:3000

## Flow

1. User signs up/logs in once and stays logged in via token.
2. User creates a channel.
3. User invites friends by entering email (app generates link + mailto action).
4. Invited user opens link, logs in with same invited email, accepts invite.
5. Only channel members can read/send that channel's messages.

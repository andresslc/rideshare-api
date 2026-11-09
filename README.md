# RideShare API

Backend for a ride-hailing platform: riders request trips, drivers receive and accept
offers in real time, and an admin back office manages pricing, users and payouts.

Built with Node.js, Express, MongoDB, Redis and Socket.IO.

> This codebase started as a commercial product that has since been discontinued. It is
> published here, with the original owner's permission, as a learning and practice
> project. All branding, credentials and infrastructure details have been removed.

## Features

| Area | What it covers |
|---|---|
| **Auth** | Phone OTP login, Google / Apple sign-in, device sessions, JWT |
| **Rides** | Fare calculation, driver dispatch queue, offers, ride upgrades, mid-trip cancellations, surge / high-demand pricing |
| **Carpool** | Shared routes and seat bookings |
| **Drivers** | Onboarding, document verification, vehicles, shifts, referral codes |
| **Payments** | Stripe (cards, Connect payouts for drivers), wallet, subscriptions and plans, promo codes |
| **Real time** | Socket.IO for the ride lifecycle, live location and chat |
| **Background jobs** | BullMQ queues and cron jobs for dispatch, journey logging and notifications |
| **Admin** | Users, drivers, ride configuration, vehicle types, rates, reports, campaigns |
| **i18n** | Server messages in English and Spanish |

## Tech stack

- **Runtime:** Node.js 22, Express 4
- **Data:** MongoDB (Mongoose), Redis (ioredis), BullMQ
- **Real time:** Socket.IO
- **Integrations:** Stripe, Twilio, SendGrid, AWS S3, Veriff, Firebase Cloud Messaging
- **Validation:** Joi and Zod
- **Tooling:** Docker Compose, Husky + lint-staged + Prettier, `node:test`

## Running locally

Self-contained stack: the API, its own MongoDB (single-node replica set, needed for
transactions) and its own Redis. Requires Docker Desktop.

1. Create `.env.local` from the template and set at least `JWT_SECRET` and `TEST_OTP`:

   ```bash
   cp .env.example .env.local
   ```

2. Provide a Firebase service account at `firebase-adminsdk.json` in the project root
   (gitignored). The app loads it at start-up; push notifications only work with a real one.

3. Start the stack and seed it:

   ```bash
   docker compose -f docker-compose.local.yml up -d --build
   docker compose -f docker-compose.local.yml exec app-local npm run seed:admin
   docker compose -f docker-compose.local.yml exec app-local npm run seed:ride:rate
   ```

| | |
|---|---|
| API | http://localhost:3000 — routes are mounted under `/api` |
| MongoDB | `localhost:27017`, database `rideshare-local` |
| Redis | `localhost:6379` |
| Seeded admin | `admin@example.com` / `Admin@123` |
| OTP | Whatever you set as `TEST_OTP` — no SMS is sent |

Third-party integrations (Twilio, SendGrid, Stripe, S3, Veriff) stay disabled until you add
your own keys to `.env.local`; flows that depend on them will fail until then.

The source tree is bind-mounted and the container runs nodemon, so edits restart the app.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with nodemon |
| `npm run check` | Validate JSON, JS syntax and app start-up (no DB needed) |
| `node --test --experimental-test-isolation=none` | Run the unit tests |
| `npm run seed:admin` | Create the default admin |
| `npm run seed:ride:rate` | Seed ride rates |
| `npm run seed:config` | Seed app configuration |

## API documentation

A Postman collection and environments live in [`postman/`](postman). They are generated
from the route files:

```bash
node scripts/generate-postman-collection.js   # regenerate
node scripts/check-postman-collection.js      # compare against the routes in code
```

The ride lifecycle (request, accept, arrive, start, complete) runs over Socket.IO rather
than HTTP; the collection's socket folder documents every event and payload.

## Project layout

```
├── config/            # environment-driven configuration
├── src/
│   ├── core/          # middlewares, sockets, queues, shared helpers, external services
│   ├── databases/     # connection and seeders
│   └── feature/       # one folder per domain: auth, ride, driver, carpool, admin, ...
├── test/              # unit tests (node:test)
├── postman/           # generated API collection and environments
├── scripts/           # CI check and Postman generator
└── view/              # email templates (Handlebars)
```

Coding conventions are in [`rules.md`](rules.md).

## Environment

All configuration comes from environment variables; see [`.env.example`](.env.example).
Never commit a filled-in `.env` file — they are all gitignored.

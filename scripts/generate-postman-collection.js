/**
 * Generates the Postman collection and environment for the RideShare API.
 *
 *   node scripts/generate-postman-collection.js
 *
 * Kept as a generator rather than a hand-edited JSON blob so the collection can
 * be regenerated when routes change, instead of drifting away from the code.
 * Endpoint list mirrors src/feature/<module>/<module>.routes.js.
 */
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "postman");

/* ────────────────────────────────────────────────────────────────────────────
   Builders
   ──────────────────────────────────────────────────────────────────────────*/

const raw = (obj) => JSON.stringify(obj, null, 2);

/**
 * @param {string} name
 * @param {string} method
 * @param {string} urlPath  e.g. "/rides/:id/coming"
 * @param {object} opts
 *   description  what it does and how to use it (markdown)
 *   body         JSON body object, or null
 *   formdata     [{key, type, value, description}]
 *   query        [{key, value, description, disabled}]
 *   auth         "user" | "driver" | "admin" | "none"  (default "user")
 *   test         extra Postman test script lines
 */
function request(name, method, urlPath, opts = {}) {
  const {
    description = "",
    body = null,
    formdata = null,
    query = [],
    auth = "user",
    test = null,
  } = opts;

  const tokenVar =
    auth === "admin"
      ? "adminToken"
      : auth === "driver"
        ? "driverToken"
        : "token";

  const segments = urlPath.replace(/^\//, "").split("/");
  const variables = segments
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => ({
      key: segment.slice(1),
      value: `{{${segment.slice(1)}}}`,
      description: `Path parameter: ${segment.slice(1)}`,
    }));

  const item = {
    name,
    request: {
      method,
      header: [],
      url: {
        raw: `{{baseUrl}}${urlPath}${
          query.length
            ? "?" +
              query
                .filter((q) => !q.disabled)
                .map((q) => `${q.key}=${q.value}`)
                .join("&")
            : ""
        }`,
        host: ["{{baseUrl}}"],
        path: segments,
        ...(query.length ? { query } : {}),
        ...(variables.length ? { variable: variables } : {}),
      },
      description,
    },
    response: [],
  };

  if (auth === "none") {
    item.request.auth = { type: "noauth" };
  } else if (tokenVar !== "token") {
    item.request.auth = {
      type: "bearer",
      bearer: [{ key: "token", value: `{{${tokenVar}}}`, type: "string" }],
    };
  }

  if (body) {
    item.request.header.push({
      key: "Content-Type",
      value: "application/json",
    });
    item.request.body = {
      mode: "raw",
      raw: raw(body),
      options: { raw: { language: "json" } },
    };
  }

  if (formdata) {
    item.request.body = { mode: "formdata", formdata };
  }

  if (test) {
    // Any script that captures a value gets the scope-aware setter prepended,
    // so no individual script has to remember to carry it.
    const exec = test.some((line) => line.includes("setVar("))
      ? [...SET_VAR_HELPER, "", ...test]
      : test;

    item.event = [
      { listen: "test", script: { type: "text/javascript", exec } },
    ];
  }

  return item;
}

const folder = (name, description, item) => ({ name, description, item });

/* ────────────────────────────────────────────────────────────────────────────
   Shared snippets
   ──────────────────────────────────────────────────────────────────────────*/

const PAGINATION = [
  { key: "page", value: "1", description: "Page number, 1-based. Default 1." },
  { key: "limit", value: "10", description: "Rows per page. Default 10." },
];

/**
 * Captured tokens have to land in the scope that {{...}} actually reads.
 *
 * An environment variable shadows a collection variable of the same name, and
 * every environment here declares an empty `token`. Writing only to the
 * collection scope therefore looks like it worked and still resolves to "",
 * which shows up later as a 401 that is very hard to explain.
 */
const SET_VAR_HELPER = [
  "const setVar = (key, value) => {",
  "  pm.collectionVariables.set(key, value);",
  "  // An active environment shadows the collection scope, so mirror it there.",
  "  if (pm.environment.name) pm.environment.set(key, value);",
  "};",
];

const AUTH_NOTE = `
**Auth:** send \`Authorization: Bearer <token>\`. The collection does this for
you from the \`token\` / \`driverToken\` / \`adminToken\` variables.`;

/* ────────────────────────────────────────────────────────────────────────────
   Folders
   ──────────────────────────────────────────────────────────────────────────*/

const authFolder = folder(
  "1. Auth",
  `Phone + OTP login for riders and drivers, onboarding, and session teardown.

**The login sequence is always the same two calls:**

1. \`POST /auth/send-otp\` with the phone and the role.
2. \`POST /auth/verify-otp\` with the same phone plus the code.

Outside production the code is whatever \`TEST_OTP\` is set to for that
environment — \`123456\` on the local stack, and the \`testOtp\` environment
variable holds it. No SMS is sent, so step 1 only creates the record. Check the
environment's own \`.env\` before assuming the value; it differs per environment
and is deliberately unset in production.

\`verify-otp\` returns \`data.token\`; the requests here store it into the right
collection variable automatically.

A driver who has not finished onboarding or document review gets
\`token: null\` back with a status explaining what is missing — that is not an
error, it is the gate.`,
  [
    request("Send OTP", "POST", "/auth/send-otp", {
      auth: "none",
      description: `Starts a login. Creates or finds the account for this phone and sends a
verification code by SMS.

Outside production the code is not sent: any seeded account logs in with the
\`TEST_OTP\` value, so you can skip straight to **Verify OTP**.

\`role\` decides which collection the account belongs to and cannot be changed
later by the same phone.`,
      body: { phone: "3055550123", role: "user", locale: "en" },
    }),

    request("Verify OTP (mobile)", "POST", "/auth/verify-otp", {
      auth: "none",
      description: `Completes the login and returns the session token used by every other request
and by the Socket.IO handshake.

**Stores \`data.token\` into the \`token\` variable automatically** (and into
\`driverToken\` when \`role\` is \`driver\`), so run this once and the rest of the
collection works.

\`token: null\` in the response is not a failure — it means the account exists but
is not cleared yet (onboarding incomplete, or documents still under review). The
response says which.

\`fcmToken\` is optional and only needed if you want push notifications.`,
      body: { phone: "3055550123", otp: "123456", role: "user", locale: "en" },
      test: [
        "const body = pm.response.json();",
        "const token = body?.data?.token;",
        "const role = JSON.parse(pm.request.body.raw || '{}').role;",
        "",
        "if (token) {",
        "  if (role === 'driver') {",
        "    setVar('driverToken', token);",
        "  } else {",
        "    setVar('token', token);",
        "  }",
        "  pm.test('Token stored', () => pm.expect(token).to.be.a('string'));",
        "} else {",
        "  console.log('No token returned — the account is not cleared yet:', body?.message);",
        "}",
        "",
        "const id = body?.data?.user?._id || body?.data?.driver?._id;",
        "if (id) setVar(role === 'driver' ? 'driverId' : 'userId', id);",
      ],
    }),

    request("Verify OTP (web)", "POST", "/auth/verify-otp-web", {
      auth: "none",
      description: `Same as **Verify OTP** but for the web client. Use this one from a browser-based
front end; use the mobile variant from the apps.`,
      body: { phone: "3055550123", otp: "123456", role: "user" },
    }),

    request("Onboard user or driver", "POST", "/auth/onboard/:role", {
      auth: "none",
      description: `Fills in the profile of an account created by the OTP step. Call it once, after
the first \`verify-otp\` returns an account that is not onboarded yet.

\`:role\` is \`user\` or \`driver\`.

**This is multipart, not JSON** — \`file\` is the profile picture. Drivers also
need \`ssn\`, \`dob\`, \`address\`, \`state\` and \`city\`; riders do not.

\`referredBy\` is the referral code of whoever invited them, if any.`,
      formdata: [
        {
          key: "phone",
          value: "3055550123",
          type: "text",
          description: "Same phone used for the OTP",
        },
        { key: "email", value: "rider@example.com", type: "text" },
        { key: "firstName", value: "Ana", type: "text" },
        { key: "lastName", value: "Rivera", type: "text" },
        {
          key: "fcmToken",
          value: "",
          type: "text",
          description: "Optional, for push notifications",
        },
        {
          key: "referredBy",
          value: "",
          type: "text",
          description: "Optional referral code",
        },
        { key: "ssn", value: "", type: "text", description: "Drivers only" },
        {
          key: "dob",
          value: "",
          type: "text",
          description: "Drivers only, YYYY-MM-DD",
        },
        {
          key: "address",
          value: "",
          type: "text",
          description: "Drivers only",
        },
        { key: "state", value: "", type: "text", description: "Drivers only" },
        { key: "city", value: "", type: "text", description: "Drivers only" },
        {
          key: "file",
          value: "",
          type: "file",
          description: "Profile picture",
        },
      ],
    }),

    request(
      "Upload driver documents",
      "POST",
      "/auth/onboard/driver/:userId/documents",
      {
        auth: "none",
        description: `Uploads the driver's licence, insurance, registration and any other required
documents. Up to 10 files in one call, under the field name \`files\`.

After this the driver waits for an admin to approve or reject each document via
\`PUT /admin/docs/respond\`. Until every document is approved, \`verify-otp\`
keeps returning \`token: null\`.`,
        formdata: [
          {
            key: "files",
            value: "",
            type: "file",
            description: "Up to 10 files",
          },
          {
            key: "documentTypes",
            value: "",
            type: "text",
            description: "Matching list of document types",
          },
        ],
      },
    ),

    request("Respond to documents", "POST", "/auth/documents/respond", {
      description: `Lets the driver re-submit a document an admin rejected, without redoing the
whole onboarding.`,
      body: { documentId: "{{documentId}}", status: "resubmitted" },
    }),

    request("Account status", "GET", "/auth/account-status", {
      description: `Where this account stands: onboarded or not, documents pending, approved or
rejected, and whether the driver may go online.

Useful as the first call after login to decide which screen to show.`,
    }),

    request("Update FCM token", "PATCH", "/auth/update-fcm", {
      description: `Refreshes the Firebase token used for push notifications. Call it whenever the
device token rotates, or the user silently stops receiving pushes.`,
      body: { fcmToken: "fcm-device-token-here" },
    }),

    request("Logout", "POST", "/auth/logout", {
      description: `Ends the session and removes the logged-device record, which also invalidates the
token server-side. A driver who is online is taken offline.`,
    }),
  ],
);

const userFolder = folder(
  "2. User (rider)",
  `Everything the rider account owns: profile, saved places, cards and wallet.
All of it requires a rider token.${AUTH_NOTE}`,
  [
    request("My profile", "GET", "/user/me", {
      description:
        "The signed-in rider's full profile, including wallet balances and rating.",
    }),
    request("Edit my profile", "PATCH", "/user/edit/me", {
      description: `Updates the rider's profile. Multipart, because \`file\` replaces the profile
picture. Send only the fields you want changed.`,
      formdata: [
        { key: "firstName", value: "Ana", type: "text" },
        { key: "lastName", value: "Rivera", type: "text" },
        { key: "email", value: "rider@example.com", type: "text" },
        {
          key: "file",
          value: "",
          type: "file",
          description: "New profile picture",
        },
      ],
    }),
    request("Attach card", "POST", "/user/attach-card", {
      description: `Saves a Stripe payment method on the rider so it can be charged for rides.

\`pmId\` is a Stripe PaymentMethod id (\`pm_...\`) that the client SDK created —
raw card numbers never touch this API.

The first card attached becomes the default.`,
      body: { pmId: "pm_1ExampleStripePaymentMethod" },
    }),
    request("List cards", "GET", "/user/cards-list", {
      description: "Every saved card, with which one is currently the default.",
    }),
    request("Set card as default", "POST", "/user/card/:card/set-as-default", {
      description: `Chooses which card gets charged. Ride payments always use the default card, so
this is how a rider switches.`,
    }),
    request("Remove card", "POST", "/user/card/:card/remove", {
      description: "Detaches a card from the rider and from Stripe.",
    }),
    request("Top up wallet", "POST", "/user/topup-wallet", {
      description: `Moves money from a saved card into the in-app wallet, so rides can be paid with
\`paymentMethod: "wallet"\` instead of a card.

May come back with \`requiresAction\` and a \`clientSecret\` if the card needs
3-D Secure; the client must complete it before the balance moves.`,
      body: { amount: 25, pmId: "pm_1ExampleStripePaymentMethod" },
    }),
    request("Transaction history", "GET", "/user/transaction-history", {
      description: "Wallet and card movements for this rider, newest first.",
      query: PAGINATION,
    }),
    request("Save location", "POST", "/user/locations/save", {
      description: `Stores a favourite place — home, work, anywhere the rider wants one tap away.
Coordinates are \`{ lat, lng }\`, unlike the ride APIs which use GeoJSON
\`[lng, lat]\` arrays.`,
      body: {
        title: "Home",
        address: "123 Brickell Ave",
        city: "Miami",
        coordinates: { lat: 25.7617, lng: -80.1918 },
      },
    }),
    request("My locations", "GET", "/user/locations", {
      description: "Saved places in display order.",
    }),
    request("Reorder locations", "PATCH", "/user/locations/re-order", {
      description:
        "Sets the display order of saved places by sending their ids in the order wanted.",
      body: { locations: ["{{locationId}}"] },
    }),
    request("Edit location", "PATCH", "/user/locations/:id", {
      description: "Renames or moves a saved place.",
      body: { title: "Office" },
    }),
    request("Delete location", "DELETE", "/user/locations/:id", {
      description: "Removes a saved place.",
    }),
    request("Change locale", "POST", "/user/change-locale", {
      description: `Switches the language of every message the server sends this rider — push
notifications, socket errors and emails. \`en\` or \`es\`.`,
      body: { locale: "es" },
    }),
    request("Delete account", "POST", "/user/delete", {
      description: `Permanently deletes the rider account. Guarded by an OTP, so send one with
\`POST /auth/send-otp\` first and pass the code here.`,
      body: { otp: "123456" },
    }),
  ],
);

const driverFolder = folder(
  "3. Driver",
  `The driver side: profile, payouts, banks and earnings. Requires a driver token
(\`driverToken\`), which these requests use automatically.

Going online, receiving ride requests and accepting them are **not** here —
they run over Socket.IO. See the **Socket.IO events** folder.`,
  [
    request("My profile", "GET", "/driver/me", {
      auth: "driver",
      description:
        "The signed-in driver's profile, vehicle and current balance.",
    }),
    request("Edit driver", "PATCH", "/driver/edit/:type", {
      auth: "driver",
      description: `Updates one section of the driver record. \`:type\` selects which — profile,
vehicle or documents — and the accepted fields change accordingly.

Multipart, up to 10 files, because vehicle and document updates carry images.`,
      formdata: [
        { key: "firstName", value: "Luis", type: "text" },
        {
          key: "files",
          value: "",
          type: "file",
          description: "Up to 10 files",
        },
      ],
    }),
    request("Dashboard", "GET", "/driver/dashboard", {
      auth: "driver",
      description:
        "Today's summary for the driver: trips, earnings and time online.",
    }),
    request("Driver stats", "GET", "/driver/:id/stats", {
      auth: "driver",
      description:
        "Longer-range performance figures for one driver: completed rides, ratings and earnings.",
      query: [
        { key: "from", value: "", description: "ISO date, start of range" },
        { key: "to", value: "", description: "ISO date, end of range" },
      ],
    }),
    request("Setup Stripe connected account", "GET", "/driver/setup-account", {
      auth: "driver",
      description: `Starts Stripe onboarding for payouts and returns the hosted link the driver must
open. **Until this is finished the driver cannot withdraw**, even with a balance.`,
    }),
    request("Attach bank", "POST", "/driver/attach-bank", {
      auth: "driver",
      description:
        "Adds a payout bank account to the driver's Stripe connected account.",
      body: {
        accountNumber: "000123456789",
        routingNumber: "110000000",
        accountHolderName: "Luis Perez",
      },
    }),
    request("List banks", "GET", "/driver/banks-list", {
      auth: "driver",
      description: "Payout accounts on file, with the default marked.",
    }),
    request("Set default bank", "POST", "/driver/set-default-bank", {
      auth: "driver",
      description: "Chooses which bank account withdrawals land in.",
      body: { bankId: "{{bankId}}" },
    }),
    request("Delete bank", "DELETE", "/driver/delete-bank", {
      auth: "driver",
      description: "Removes a payout account.",
      body: { bankId: "{{bankId}}" },
    }),
    request("Withdraw", "POST", "/driver/withdraw", {
      auth: "driver",
      description: `Moves earned balance to the default bank account. Fails if Stripe onboarding is
incomplete or the balance is short.`,
      body: { amount: 120.5 },
    }),
    request("Transaction history", "GET", "/driver/transaction-history", {
      auth: "driver",
      description: `Every credit and debit on the driver: ride earnings, cancellation fees and
withdrawals.

Ride earnings are credited off the **pre-discount** fare, so a promo the rider
used never reduces what the driver is paid.`,
      query: PAGINATION,
    }),
    request("Change locale", "POST", "/driver/change-locale", {
      auth: "driver",
      description:
        "Switches the language of server messages for this driver. `en` or `es`.",
      body: { locale: "es" },
    }),
    request("Delete account", "POST", "/driver/delete", {
      auth: "driver",
      description: "Permanently deletes the driver account. Guarded by an OTP.",
      body: { otp: "123456" },
    }),
  ],
);

const rideFolder = folder(
  "4. Rides",
  `**Read this before using the ride endpoints.**

The ride *lifecycle* is not HTTP. Requesting a ride, accepting it, arriving,
starting and completing all happen over Socket.IO — see the
**Socket.IO events** folder for the full sequence.

What lives here is everything around it: price quotes, history, and the list of
open requests a driver can still take.

**How a ride is assigned:** the rider requests, and the server opens an
escalating search — 1 mile, then 2, 3 and 5, roughly ten seconds per ring —
notifying every eligible driver in each new ring. The first driver to accept
gets it; everyone else is told the ride is gone and handed a refreshed list. If
the last ring passes with no taker, the ride is marked \`expired\` and the rider
is told. The rider never picks from a list of drivers.`,
  [
    request("Fare calculator", "POST", "/rides/fare-calculator", {
      description: `Quotes a price before the rider commits. Call it as the destination changes, and
send the result back as \`rideFare\` on the socket request so the rider is
charged what they were shown.

\`pickupCity\` is optional: when the city has its own rate card it is used,
otherwise the global rates apply. Peak-hour multipliers are already included in
the number returned.`,
      body: { rideType: "economy", miles: 4.2, pickupCity: "Miami" },
    }),
    request("Available requests (driver)", "GET", "/rides", {
      description: `Open ride requests near the driver, newest first. This is the **pull** side of
dispatch: the socket push only reaches drivers who were online when the request
was created, so a driver who comes online later finds work here.

Only rides matching the driver's own vehicle type and inside the configured
radius are returned. The driver must be online and have sent at least one
location update, otherwise this returns \`DRIVER_IS_OFFLINE\`.

How quickly a late-joining driver sees a ride depends on how often the app polls
this endpoint.`,
      auth: "driver",
      query: [
        {
          key: "status",
          value: "requested",
          description: "Ride status to list. Defaults to `requested`.",
        },
        ...PAGINATION,
      ],
    }),
    request("Ride by id", "GET", "/rides/:id", {
      description:
        "One ride in full, with rider, driver, vehicle and timestamps.",
    }),
    request("Ride history", "GET", "/rides/history", {
      description: `Past rides for whoever is signed in — the rider sees theirs, the driver sees
theirs. Rides cancelled before a driver was assigned are left out.`,
      query: PAGINATION,
    }),
    request("I am coming", "POST", "/rides/:id/coming", {
      description: `The rider tells a waiting driver they are on their way to the car. Moves the ride
from \`arrived\` to \`coming\` and notifies the driver.

Optional: a ride can go straight from \`arrived\` to \`in-progress\` without it.`,
    }),
    request("Share ride link", "GET", "/rides/share/:id", {
      description:
        "Builds a public link so the rider can share live trip progress with someone else.",
    }),
  ],
);

const carpoolFolder = folder(
  "5. Carpool",
  `Carpool works differently from a normal ride, and this is the part people get
wrong most often.

There is **no dispatch and no radius search**. Drivers publish routes in
advance; the rider searches those published routes and books a seat on one. The
escalating ring search described in the Rides folder does not apply here.

Booking and the in-trip events run over Socket.IO; the endpoints here are the
search and the read side.`,
  [
    request("Find matching carpools", "POST", "/carpool/user/matches", {
      description: `The rider's entry point to carpool: given a pickup, a drop-off and a time, returns
the published driver routes that can absorb the trip, with available seats and
price per seat.

Matching checks both ends against the route: a pickup or drop-off too far from
the line is rejected with \`PICKUP_NOT_WITHIN_ROUTE_RADIUS\` or
\`DROPOFF_NOT_WITHIN_ROUTE_RADIUS\`.

Coordinates are GeoJSON order — \`[longitude, latitude]\`.`,
      body: {
        pickupPoint: {
          placeName: "Brickell",
          location: { type: "Point", coordinates: [-80.1918, 25.7617] },
        },
        dropOffPoint: {
          placeName: "Wynwood",
          location: { type: "Point", coordinates: [-80.1994, 25.801] },
        },
        seats: 1,
        departureTime: "2026-09-20T14:00:00.000Z",
      },
    }),
    request("Carpool by id", "GET", "/carpool/:id", {
      description: "One carpool route with its stops and status.",
    }),
    request("Carpool details", "GET", "/carpool/:id/details", {
      description:
        "Expanded view of a carpool: driver, vehicle, route and pricing.",
    }),
    request("Carpool passengers", "GET", "/carpool/:id/passengers", {
      description:
        "Who is booked on this carpool. Cancelled and rejected bookings are filtered out.",
    }),
    request("Passenger details", "GET", "/carpool/:id/passengers/details", {
      description:
        "Per-passenger detail for the driver: pickup, drop-off, seats and payment state.",
    }),
    request("Carpool history", "GET", "/carpool/history", {
      description: "Past carpools for whoever is signed in, rider or driver.",
      query: PAGINATION,
    }),
    request("Share carpool link", "GET", "/carpool/share/:id", {
      description: "Public link for sharing a carpool trip.",
    }),
  ],
);

const reviewFolder = folder(
  "6. Reviews",
  "Ratings riders and drivers leave each other after a ride. One review per ride per side.",
  [
    request("Create review", "POST", "/review", {
      description: `Rates the other party after a completed ride. \`rating\` is 1 to 5. The target is
inferred from who is signed in: a rider reviews the driver and the reverse.`,
      body: {
        ride: "{{rideId}}",
        rating: 5,
        comment: "Smooth ride, great conversation.",
      },
    }),
    request("Update review", "PUT", "/review", {
      description: "Edits a review already left. Same shape as creating one.",
      body: { reviewId: "{{reviewId}}", rating: 4, comment: "Updated note." },
    }),
    request("Delete review", "DELETE", "/review/:reviewId", {
      description:
        "Removes a review and recalculates the target's average rating.",
    }),
    request("List reviews", "GET", "/review", {
      description:
        "Reviews for a person. Pass whose reviews you want; defaults to the signed-in account.",
      query: [
        {
          key: "userId",
          value: "{{userId}}",
          description: "Whose reviews to list",
        },
        ...PAGINATION,
      ],
    }),
  ],
);

const reportFolder = folder(
  "7. Reports",
  "Safety and conduct reports raised during or after a ride. Admins triage them under the Admin folder.",
  [
    request("Create report", "POST", "/report", {
      description: `Raises a report against the other party on a ride. \`reason\` is the category and
\`description\` the free text. Goes into the admin queue as \`pending\`.`,
      body: {
        ride: "{{rideId}}",
        reason: "unsafe_driving",
        description: "Driver was on the phone the whole trip.",
      },
    }),
    request("Delete report", "DELETE", "/report/:reportId", {
      description: "Withdraws a report the signed-in account raised.",
    }),
    request("List my reports", "GET", "/report", {
      description:
        "Reports raised by the signed-in account, with their current status.",
      query: PAGINATION,
    }),
  ],
);

const notificationFolder = folder(
  "8. Notifications",
  "In-app notification inbox and per-category push preferences.",
  [
    request("List notifications", "GET", "/notification", {
      description: "The signed-in account's notification inbox, newest first.",
      query: PAGINATION,
    }),
    request("Toggle notifications", "POST", "/notification/:role/toggle", {
      description: `Turns a notification category on or off for this account. \`:role\` is \`user\` or
\`driver\`; the body names the category and the desired state.`,
      body: { type: "RIDE_UPDATES", enabled: false },
    }),
    request(
      "Delete one notification",
      "DELETE",
      "/notification/:notificationId",
      { description: "Removes a single notification from the inbox." },
    ),
    request("Clear inbox", "DELETE", "/notification", {
      description: "Removes every notification for the signed-in account.",
    }),
    request("Send test notification", "POST", "/notification/test", {
      description: `Fires a push at the signed-in device. Use it to confirm the FCM token is valid
when a user reports missing notifications.`,
      body: { title: "Test", description: "If you can read this, push works." },
    }),
  ],
);

const chatFolder = folder(
  "9. Chat",
  "In-ride messaging between rider and driver. Live delivery is over Socket.IO; these endpoints send and read history.",
  [
    request("Send message", "POST", "/chat/send", {
      description: `Sends a message inside a ride or carpool conversation. \`contextId\` is the ride or
carpool id, which is what scopes the conversation.`,
      body: { contextId: "{{rideId}}", message: "I am by the blue awning." },
    }),
    request("Conversation history", "GET", "/chat/:contextId/history", {
      description: "Messages for one ride or carpool, oldest first.",
      query: PAGINATION,
    }),
  ],
);

const subscriptionFolder = folder(
  "10. Subscriptions",
  `Driver subscription plans, billed through Stripe. A driver may need an active
subscription to go online, depending on configuration.`,
  [
    request(
      "Purchase subscription",
      "POST",
      "/subscription/purchase/:priceId/:id",
      {
        auth: "driver",
        description: `Starts a subscription for a driver. \`:priceId\` is the Stripe price and \`:id\`
the driver. Returns the Stripe client secret the app completes.

See **Plans** for the available price ids.`,
      },
    ),
    request("Subscription details", "GET", "/subscription/details/:id", {
      auth: "driver",
      description:
        "Current subscription for a driver: status, period and renewal.",
    }),
    request("Cancel subscription", "POST", "/subscription/cancel", {
      auth: "driver",
      description:
        "Cancels at the end of the paid period; access continues until then.",
      body: { subscriptionId: "{{subscriptionId}}" },
    }),
  ],
);

const miscFolder = folder(
  "11. Config, Plans & Promo codes",
  "Public-ish reference data the apps read at startup, plus promo redemption.",
  [
    request("Get config", "GET", "/config", {
      description:
        "App-wide settings the clients read on launch: feature switches and operational values.",
    }),
    request("Get plans", "GET", "/plan", {
      description:
        "Subscription plans available to drivers, with the Stripe price ids used by **Purchase subscription**.",
    }),
    request("Apply promo code", "POST", "/promo-code/apply", {
      description: `Validates a promo code against a quoted fare and returns the discount and the
final price. Apply it **before** requesting the ride, then pass \`codeId\`,
\`campaignId\` and \`originalRideFare\` on the socket request.

A code can take the fare to zero. That is a supported case: the rider pays
nothing, no payment API is called, and the driver is still paid the full
pre-discount fare with the platform absorbing it.`,
      body: { code: "WELCOME10", rideType: "economy", rideFare: 18.5 },
    }),
  ],
);

/* ── Admin ─────────────────────────────────────────────────────────────────*/

const adminCampaigns = folder(
  "Promo campaigns",
  `Campaigns group promo codes and hold the rules: discount, limits, eligible ride
types and validity window. Mounted under \`/admin/campaigns\`.`,
  [
    request("Create campaign", "POST", "/admin/campaigns", {
      auth: "admin",
      description: `Creates a campaign. \`rideTypes\` limits which categories the codes work on.

Discount and budget figures are business decisions — confirm them before
creating a live campaign.`,
      body: {
        name: "Welcome September",
        discountType: "percentage",
        discountValue: 10,
        rideTypes: ["economy", "luxury"],
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-30T23:59:59.000Z",
        usageLimitPerUser: 1,
      },
    }),
    request("List campaigns", "GET", "/admin/campaigns", {
      auth: "admin",
      description: "All campaigns with status and headline usage.",
      query: PAGINATION,
    }),
    request("Campaign by id", "GET", "/admin/campaigns/:id", {
      auth: "admin",
      description: "One campaign with its full rule set.",
    }),
    request("Update campaign", "PATCH", "/admin/campaigns/:id", {
      auth: "admin",
      description: "Edits campaign rules. Send only what changes.",
      body: { discountValue: 15 },
    }),
    request("Toggle campaign status", "PATCH", "/admin/campaigns/:id/status", {
      auth: "admin",
      description: "Activates or pauses a campaign without deleting it.",
      body: { status: "paused" },
    }),
    request("Delete campaign", "DELETE", "/admin/campaigns/:id", {
      auth: "admin",
      description:
        "Removes a campaign. Codes already redeemed stay in the ledger.",
    }),
    request("Campaign codes", "GET", "/admin/campaigns/:id/codes", {
      auth: "admin",
      description: "Individual codes issued under a campaign.",
      query: PAGINATION,
    }),
    request("Campaign stats", "GET", "/admin/campaigns/:id/stats", {
      auth: "admin",
      description: "Redemptions, discount given and reach for one campaign.",
    }),
    request("Campaign redemptions", "GET", "/admin/campaigns/:id/redemptions", {
      auth: "admin",
      description: "Who redeemed this campaign and when.",
      query: PAGINATION,
    }),
    request(
      "User redemption history",
      "GET",
      "/admin/campaigns/:id/redemptions/:userId",
      {
        auth: "admin",
        description:
          "One user's redemption history for a campaign, for disputes.",
      },
    ),
  ],
);

const adminFolder = folder(
  "12. Admin",
  `Back office. Everything here needs an **admin** token: run **Admin login** first
and the \`adminToken\` variable is filled in automatically.

Admin accounts are email + password, not phone + OTP like riders and drivers.`,
  [
    request("Admin login", "POST", "/admin/login", {
      auth: "none",
      description:
        "Signs an admin in and returns the token. **Stores it into `adminToken` automatically.**",
      body: { email: "admin@example.com", password: "changeme123" },
      test: [
        "const body = pm.response.json();",
        "const token = body?.data?.token;",
        "if (token) {",
        "  setVar('adminToken', token);",
        "  pm.test('Admin token stored', () => pm.expect(token).to.be.a('string'));",
        "}",
      ],
    }),
    request("Forgot password", "POST", "/admin/forgot-password", {
      auth: "none",
      description: "Emails a reset code to an admin.",
      body: { email: "admin@example.com" },
    }),
    request("Verify reset OTP", "POST", "/admin/verify-otp", {
      auth: "none",
      description: "Confirms the emailed code and authorises a reset.",
      body: { email: "admin@example.com", otp: "123456" },
    }),
    request("Reset password", "POST", "/admin/reset-password", {
      auth: "none",
      description: "Sets a new password after the code is verified.",
      body: { email: "admin@example.com", password: "newpassword123" },
    }),
    request("Update password", "PUT", "/admin/update-password", {
      auth: "admin",
      description: "Changes the signed-in admin's own password.",
      body: { currentPassword: "changeme123", newPassword: "newpassword123" },
    }),

    request("Dashboard stats", "GET", "/admin/dashboard-stats", {
      auth: "admin",
      description:
        "Headline counters for the admin home: users, drivers, rides and revenue.",
    }),
    request("Birds eye view", "GET", "/admin/birds-eye-view", {
      auth: "admin",
      description:
        "Live operational map data: where drivers are and what is in flight right now.",
    }),
    request("Requests count", "GET", "/admin/requests-count", {
      auth: "admin",
      description: "Ride requests over time, for spotting demand peaks.",
    }),
    request("Ride analytics", "GET", "/admin/ride-analytics", {
      auth: "admin",
      description:
        "Ride volume, completion and cancellation broken down over a period.",
      query: [
        { key: "from", value: "" },
        { key: "to", value: "" },
      ],
    }),
    request("Subscription revenue", "GET", "/admin/subscription-revenue", {
      auth: "admin",
      description: "Revenue from driver subscriptions over a period.",
    }),

    request("List drivers", "GET", "/admin/drivers", {
      auth: "admin",
      description:
        "Drivers with filters for status, document state and search.",
      query: [
        { key: "search", value: "" },
        { key: "status", value: "" },
        ...PAGINATION,
      ],
    }),
    request("List suspended drivers", "GET", "/admin/drivers/suspended", {
      auth: "admin",
      description: "Drivers currently suspended, automatically or by an admin.",
      query: PAGINATION,
    }),
    request(
      "Driver suspension detail",
      "GET",
      "/admin/drivers/:id/suspension",
      {
        auth: "admin",
        description: "Why a driver is suspended and until when.",
      },
    ),
    request("Suspend driver", "POST", "/admin/drivers/:id/suspend", {
      auth: "admin",
      description: `Takes a driver offline and blocks new assignments. A driver mid-ride finishes it
first.

Critique the behaviour, not the person, in \`reason\` — it is stored on the record.`,
      body: {
        reason: "Repeated late cancellations",
        until: "2026-10-01T00:00:00.000Z",
      },
    }),
    request("Unsuspend driver", "POST", "/admin/drivers/:id/unsuspend", {
      auth: "admin",
      description: "Lifts a suspension and lets the driver go online again.",
    }),
    request(
      "Driver transactions",
      "GET",
      "/admin/drivers/:driverId/transactions",
      {
        auth: "admin",
        description:
          "Full ledger for one driver: earnings, fees and withdrawals.",
        query: PAGINATION,
      },
    ),

    request("List users", "GET", "/admin/users", {
      auth: "admin",
      description: "Riders, with search and status filters.",
      query: [{ key: "search", value: "" }, ...PAGINATION],
    }),
    request("User by id", "GET", "/admin/users/:id", {
      auth: "admin",
      description: `One rider in full: profile, wallet, ride counts and status.

In staging and production, admins outside the internal domain do not see
accounts flagged as internal test identities — so a record you can find locally
may be invisible to an ordinary admin on a deployed environment.`,
    }),
    request("Update user", "PATCH", "/admin/users/:id", {
      auth: "admin",
      description: `Edits a rider's or driver's record. Admin roles only.

Send type "driver" to edit a driver; without it the record is treated as a
rider. Only allow-listed fields are kept: firstName, lastName, email, phone
(phoneNumber is accepted as an alias), address, city, state, dob (riders),
ssn, vehicleType and subscriptionStatus (drivers), and balance with reason.

Phone is stored as digits with country code and no "+". Changing it also
changes the number the person logs in with, and returns 409 if another active
account with the same role already uses it. SSN must be 9 digits and is only
ever returned masked (***-**-1234).`,
      body: {
        type: "driver",
        phone: "13055551234",
        address: "100 Main St",
        city: "Miami",
        state: "FL",
        ssn: "123-45-6789",
      },
    }),
    request("Update user status", "PATCH", "/admin/users/:id/status", {
      auth: "admin",
      description: "Blocks or unblocks a rider.",
      body: { status: "blocked" },
    }),
    request("Delete user", "DELETE", "/admin/users/:id", {
      auth: "admin",
      description: "Permanently deletes a rider account.",
    }),
    request("Export users CSV", "GET", "/admin/users/export", {
      auth: "admin",
      description:
        "Downloads riders as CSV. Returns a file, not JSON — use **Send and Download** in Postman.",
    }),

    request("List documents", "GET", "/admin/docs", {
      auth: "admin",
      description:
        "Driver documents awaiting review, with their current state.",
      query: [{ key: "status", value: "pending" }, ...PAGINATION],
    }),
    request("Respond to documents", "PUT", "/admin/docs/respond", {
      auth: "admin",
      description: `Approves or rejects a driver document. **This is the gate**: a driver only gets a
login token once every required document is approved.

A rejection should say what was wrong so the driver can re-submit.`,
      body: { documentId: "{{documentId}}", status: "approved", reason: "" },
    }),
    request("List vehicles", "GET", "/admin/vehicles", {
      auth: "admin",
      description: "Vehicles registered by drivers.",
      query: PAGINATION,
    }),
    request("Create vehicle type", "POST", "/admin/vehicle-types", {
      auth: "admin",
      description: "Adds a vehicle category drivers can register under.",
      body: { name: "SUV", description: "Six seats" },
    }),
    request("List vehicle types", "GET", "/admin/vehicle-types", {
      auth: "admin",
      description: "Every vehicle category.",
    }),
    request("Update vehicle type", "PUT", "/admin/vehicle-types/:id", {
      auth: "admin",
      description: "Edits a vehicle category.",
      body: { name: "SUV" },
    }),
    request("Delete vehicle type", "DELETE", "/admin/vehicle-types/:id", {
      auth: "admin",
      description: "Removes a vehicle category.",
    }),

    request("List rides", "GET", "/admin/rides", {
      auth: "admin",
      description: "All rides with status and date filters.",
      query: [{ key: "status", value: "" }, ...PAGINATION],
    }),
    request("Ride by id", "GET", "/admin/rides/:id", {
      auth: "admin",
      description: "One ride in full, from the admin view.",
    }),
    request("Export rides CSV", "GET", "/admin/rides/export", {
      auth: "admin",
      description: "Downloads rides as CSV. Returns a file, not JSON.",
    }),
    request("List carpool rides", "GET", "/admin/carpool-rides", {
      auth: "admin",
      description: "Carpool trips with filters.",
      query: PAGINATION,
    }),
    request("Carpool ride by id", "GET", "/admin/carpool-rides/:id", {
      auth: "admin",
      description: "One carpool trip in full.",
    }),
    request(
      "Journey timeline",
      "GET",
      "/admin/journeys/:journeyType/:journeyId/timeline",
      {
        auth: "admin",
        description: `The audit trail of a trip, event by event: requested, assigned, arrived, OTP
verified, paid, completed, with locations attached.

\`:journeyType\` is \`ride\` or \`carpool\`. This is the first place to look when
somebody disputes what happened.`,
      },
    ),

    request("List reports", "GET", "/admin/reports", {
      auth: "admin",
      description: "Safety and conduct reports queue.",
      query: [{ key: "status", value: "pending" }, ...PAGINATION],
    }),
    request("Report by id", "GET", "/admin/reports/:id", {
      auth: "admin",
      description: "One report with both sides and the ride it refers to.",
    }),
    request("Update report status", "PATCH", "/admin/reports/:id/:status", {
      auth: "admin",
      description: "Moves a report through triage. `:status` is the new state.",
    }),

    request("List withdrawals", "GET", "/admin/withdrawals", {
      auth: "admin",
      description: "Driver payout requests and their state.",
      query: PAGINATION,
    }),
    request("Rewarded balances", "GET", "/admin/rewarded-balances", {
      auth: "admin",
      description: "Promotional credit currently held by riders.",
    }),
    request(
      "Rewarded balance history",
      "GET",
      "/admin/rewarded-balance-history",
      {
        auth: "admin",
        description: "How promotional credit was granted and spent.",
        query: PAGINATION,
      },
    ),

    request("Create notification", "POST", "/admin/notifications", {
      auth: "admin",
      description:
        "Sends a broadcast or targeted notification from the back office.",
      body: {
        title: "Service update",
        description: "Scheduled maintenance tonight.",
        audience: "all",
      },
    }),
    request("List notifications", "GET", "/admin/notifications", {
      auth: "admin",
      description: "Every notification sent from the back office.",
      query: PAGINATION,
    }),
    request("My notifications", "GET", "/admin/notifications/mine", {
      auth: "admin",
      description: "Notifications addressed to the signed-in admin.",
    }),
    request("Notification by id", "GET", "/admin/notifications/:id", {
      auth: "admin",
      description: "One back-office notification.",
    }),
    request("Update notification", "PATCH", "/admin/notifications/:id", {
      auth: "admin",
      description: "Edits a scheduled notification before it goes out.",
      body: { title: "Updated title" },
    }),
    request("Delete notification", "DELETE", "/admin/notifications/:id", {
      auth: "admin",
      description: "Removes a back-office notification.",
    }),

    request("Get ride configuration", "GET", "/admin/ride-configuration", {
      auth: "admin",
      description: `The distance settings dispatch runs on.

- \`dispatchRadiusLadderMiles\` — the escalating search, default \`[1, 2, 3, 5]\`
- \`dispatchRingTimeoutSeconds\` — how long each ring stays open, default \`10\`
- \`nearbyRadius\` — radius for the driver's pull list (\`GET /rides\`)
- \`carpoolNearbyRadius\` — how far a pickup may sit from a published route`,
    }),
    request("Update ride configuration", "PATCH", "/admin/ride-configuration", {
      auth: "admin",
      description: `Tunes dispatch. Send only what changes.

**The ladder is validated, not taken on trust:** strictly ascending, 1 to 6
rings, and **no radius above 5 miles**. Five miles is about twelve minutes of
pickup ETA at urban speeds, which is the edge of what a waiting rider tolerates;
going past it is a product decision, so it is enforced in code rather than left
to this endpoint.

A tighter ladder like \`[0.5, 1, 2]\` suits dense areas. A longer ring timeout
gives drivers more time to answer but makes the rider wait longer.`,
      body: {
        dispatchRadiusLadderMiles: [1, 2, 3, 5],
        dispatchRingTimeoutSeconds: 10,
      },
    }),
    request("Get ride rates", "GET", "/admin/ride-rates", {
      auth: "admin",
      description: "Global and per-city pricing, plus peak windows.",
      query: [{ key: "city", value: "" }],
    }),
    request("Update ride rate", "PUT", "/admin/ride-rates/:rideType", {
      auth: "admin",
      description:
        "Sets global pricing for one ride category. **Pricing is David's call — produce the change, do not publish it unilaterally.**",
      body: { baseFare: 3.5, perMile: 1.75, perMinute: 0.3 },
    }),
    request("Create city ride rate", "POST", "/admin/city-ride-rates", {
      auth: "admin",
      description:
        "Adds a city-specific rate card that overrides the global one.",
      body: {
        cityKey: "miami",
        rideType: "economy",
        baseFare: 3.75,
        perMile: 1.9,
      },
    }),
    request("Update city ride rate", "PUT", "/admin/city-ride-rates/:id", {
      auth: "admin",
      description: "Edits a city rate card.",
      body: { perMile: 2.0 },
    }),
    request("Delete city ride rate", "DELETE", "/admin/city-ride-rates/:id", {
      auth: "admin",
      description:
        "Removes a city rate card; that city falls back to global rates.",
    }),
    request("List peak windows", "GET", "/admin/peak-windows", {
      auth: "admin",
      description: "Time ranges where a surge multiplier applies.",
    }),
    request("Create peak window", "POST", "/admin/peak-windows", {
      auth: "admin",
      description: "Adds a surge window.",
      body: {
        name: "Friday night",
        dayOfWeek: 5,
        startHour: 20,
        endHour: 23,
        multiplier: 1.4,
      },
    }),
    request("Update peak window", "PUT", "/admin/peak-windows/:id", {
      auth: "admin",
      description: "Edits a surge window.",
      body: { multiplier: 1.5 },
    }),
    request("Delete peak window", "DELETE", "/admin/peak-windows/:id", {
      auth: "admin",
      description: "Removes a surge window.",
    }),

    request("Create admin user", "POST", "/admin/admin-users", {
      auth: "admin",
      description: "Adds a back-office account with a role.",
      body: {
        email: "ops@example.com",
        password: "changeme123",
        role: "admin",
        firstName: "Ops",
        lastName: "Team",
      },
    }),
    request("List admin users", "GET", "/admin/admin-users", {
      auth: "admin",
      description: "Back-office accounts and their roles.",
      query: PAGINATION,
    }),
    request("Update admin user", "PATCH", "/admin/admin-users/:id", {
      auth: "admin",
      description: "Changes a back-office account's role or details.",
      body: { role: "support" },
    }),
    request("Delete admin user", "DELETE", "/admin/admin-users/:id", {
      auth: "admin",
      description: "Removes a back-office account.",
    }),

    adminCampaigns,
  ],
);

const webhookFolder = folder(
  "13. Webhooks (inbound)",
  `**These are called by Stripe and Veriff, not by you.** They are here so you can
see the contract and replay a payload while debugging.

Both verify a provider signature, so a hand-made request will be rejected unless
you sign it. Use the Stripe CLI (\`stripe listen --forward-to\`) to exercise the
real path.

The Stripe hook is what finishes a card-paid ride: it credits the driver and
releases the ride once the payment intent succeeds.`,
  [
    request("Stripe webhook", "POST", "/webhook/stripe/:source", {
      auth: "none",
      description: `Receives Stripe events. \`:source\` selects which signing secret is used, since
the platform account and connected accounts each have their own.

Handles payment success (credits the driver), subscription lifecycle, payout
results and account updates.`,
      body: {
        id: "evt_example",
        type: "payment_intent.succeeded",
        data: { object: {} },
      },
    }),
    request("Veriff webhook", "POST", "/webhook/veriff", {
      auth: "none",
      description:
        "Receives driver identity verification results from Veriff and updates the driver record.",
      body: { status: "approved", vendorData: "{{driverId}}" },
    }),
  ],
);

/* ── Socket.IO documentation ───────────────────────────────────────────────*/

const socketFolder = folder(
  "14. Socket.IO events (reference)",
  `**The whole ride lifecycle runs on Socket.IO, not HTTP.** Postman cannot hold
Socket.IO events in a collection, so this folder documents them. To try them,
create a **New → Socket.IO** request in Postman pointing at \`{{socketUrl}}\`.

### Connecting

Connect to \`{{socketUrl}}\` with the session token in the handshake:

\`\`\`json
{ "auth": { "token": "<the token from verify-otp>" } }
\`\`\`

The server reads the role from the token — the same connection behaves
differently for a rider and a driver.

### Driver: going on duty

| Event | Direction | What it does |
|---|---|---|
| \`driver:online\` | send | Marks the driver available. Checks shift limits first — over 12 hours and it refuses. |
| \`driver:location:update\` | send | \`{ location: { coordinates: [lng, lat] } }\`. **Required before the driver can be found** — going online alone does not put them on the map. Send it continuously. |
| \`driver:offline\` | send | Goes off duty. Deferred if a ride is in progress. |

### Rider: requesting

| Event | Direction | What it does |
|---|---|---|
| \`ride:request:create\` | send | Creates the request and starts the escalating search. See the payload below. |
| \`ride:search:status\` | receive | One per ring: \`{ ring, totalRings, radiusMiles, driversNotified, totalNotified, nextRingInSeconds }\`. Use it to show real progress instead of a blank spinner. |
| \`ride:search:exhausted\` | receive | Every ring passed with no taker. The ride is now \`expired\`. |
| \`ride:incoming\` | receive (driver) | A request the driver may accept. |
| \`ride:request:accept\` | send (driver) | Claims the ride. **First to arrive wins.** |
| \`ride:request:taken\` | receive (driver) | Somebody else won it. Carries \`availableRides\`, a refreshed list, so the dead request can leave the screen. |
| \`ride:status:update\` | receive | Emitted to both sides on every state change. |

**\`ride:request:create\` payload:**

\`\`\`json
{
  "category": "economy",
  "pickupPoint": {
    "placeName": "Brickell",
    "location": { "type": "Point", "coordinates": [-80.1918, 25.7617] }
  },
  "dropOffPoint": {
    "placeName": "Wynwood",
    "location": { "type": "Point", "coordinates": [-80.1994, 25.8010] }
  },
  "rideDistance": 4.2,
  "rideFare": 18.5,
  "averageTime": 12,
  "paymentMethod": "wallet"
}
\`\`\`

\`category\` is \`economy\`, \`luxury\` or \`carpool\`. **Carpool does not dispatch** —
the server answers with a pointer to \`POST /carpool/user/matches\`. The older
field name \`rideType\` is still accepted so existing apps keep working.

\`rideFare\` should be the number \`POST /rides/fare-calculator\` returned, so the
rider is charged what they were shown. A promo code adds \`codeId\`,
\`campaignId\` and \`originalRideFare\`.

### The trip itself

| Event | Direction | What it does |
|---|---|---|
| \`ride:driver:arrive\` | send (driver) | "I am at the pickup." **Rejected unless the driver is within 100 m** of the pickup point. |
| \`ride:start\` | send (driver) | \`{ rideId, otp }\`. The rider reads the 4-digit code aloud. **Payment is taken here, at the start, not at the end.** |
| \`ride:payment:verification\` | receive | The card needs 3-D Secure. Carries \`clientSecret\`; the ride waits until it clears. |
| \`ride:complete\` | send (driver) | Ends the trip and frees the driver. |
| \`ride:cancel\` | send (either) | Cancels. A cancellation fee may apply depending on when. |
| \`ride:resume\` | both | Rebuilds state after a reconnect. A rider reconnecting mid-search rejoins the room and keeps receiving \`ride:search:status\`. |
| \`user:location:update\` | send (rider) | The rider's live position, for the driver's map. |

### Retired

\`send:offer\`, \`accept:offer\` and \`reject:offer\` belonged to the old flow where
the rider picked a driver from a list of offers. They now answer
\`FEATURE_DISABLED\`. The rider no longer chooses a driver — the first driver to
accept is assigned.`,
  [],
);

/* ── Test run ──────────────────────────────────────────────────────────────*/

const ok2xx = (label) => [
  `pm.test("${label}", () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));`,
];

const rejected = (label) => [
  `pm.test("${label}", () => {`,
  "  pm.expect(pm.response.code, 'should not be accepted').to.be.within(400, 499);",
  "});",
  "pm.test('The error says why', () => {",
  "  const body = pm.response.json();",
  "  pm.expect(body.success).to.eql(false);",
  "  pm.expect(body.message, JSON.stringify(body)).to.be.a('string').and.not.empty;",
  "});",
];

const testPlanFolder = folder(
  "15. Test run — dispatch & free rides",
  `An ordered, runnable check of the behaviour that changed with the escalating
dispatch. Open the **Collection Runner**, select this folder only, and run it
top to bottom — each request asserts its own result.

**Before you run it** put a back-office email and password into the first
request. Everything here reads or writes the ride configuration, so point it at
**Local** or **Dev**, never Production.

**What this folder can and cannot prove.** Postman speaks HTTP, and the ring
search, the race between drivers and the free-ride payout are all Socket.IO.
This folder covers the parts with an HTTP surface — the ladder and its
validation, the retired endpoints, the driver list. The socket scenarios are
written up step by step in \`PLAN_DE_PRUEBAS_DESPACHO.md\` at the repository
root, with the exact events to send and what to expect back.

The ladder is restored to its default at the end, so the run leaves the
environment as it found it.`,
  [
    request("01 · Admin login", "POST", "/admin/login", {
      auth: "none",
      description: `Fills \`adminToken\`.

The body carries the credentials \`npm run seed:admin\` creates on a local stack.
On dev or staging replace them with a real back-office account — the seeded one
does not exist there.`,
      body: { email: "admin@example.com", password: "Admin@123" },
      test: [
        "const body = pm.response.json();",
        "const token = body?.data?.token;",
        "pm.test('Admin login succeeded', () => pm.expect(token, body?.message).to.be.a('string'));",
        "if (token) setVar('adminToken', token);",
      ],
    }),

    request(
      "02 · Ladder defaults are present",
      "GET",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description: `Reads the dispatch settings. On a database that never had them, the service
backfills the defaults on this first read — so a fresh environment returns
\`[1, 2, 3, 5]\` and a 10 second ring, rather than an empty object.`,
        test: [
          "const config = pm.response.json().data;",
          "",
          "pm.test('The ladder exists', () => {",
          "  pm.expect(config.dispatchRadiusLadderMiles, JSON.stringify(config)).to.be.an('array').that.is.not.empty;",
          "});",
          "",
          "pm.test('It starts at 1 mile and ends at the 5 mile cap', () => {",
          "  const ladder = config.dispatchRadiusLadderMiles;",
          "  pm.expect(ladder[0]).to.eql(1);",
          "  pm.expect(ladder[ladder.length - 1]).to.eql(5);",
          "});",
          "",
          "pm.test('Rings are strictly ascending', () => {",
          "  const ladder = config.dispatchRadiusLadderMiles;",
          "  ladder.forEach((r, i) => { if (i) pm.expect(r, `ring ${i}`).to.be.above(ladder[i - 1]); });",
          "});",
          "",
          "pm.test('Ring timeout is a whole number of seconds', () => {",
          "  pm.expect(config.dispatchRingTimeoutSeconds).to.be.a('number');",
          "  pm.expect(config.dispatchRingTimeoutSeconds % 1).to.eql(0);",
          "});",
          "",
          "setVar('ladderBackup', JSON.stringify(config.dispatchRadiusLadderMiles));",
        ],
      },
    ),

    request(
      "03 · Tighten the ladder (accepted)",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "A denser ladder for a busy area. Valid: ascending, inside the cap.",
        body: {
          dispatchRadiusLadderMiles: [0.5, 1, 2],
          dispatchRingTimeoutSeconds: 8,
        },
        test: [
          ...ok2xx("Accepted"),
          "pm.test('The new ladder came back', () => {",
          "  pm.expect(pm.response.json().data.dispatchRadiusLadderMiles).to.eql([0.5, 1, 2]);",
          "});",
        ],
      },
    ),

    request(
      "04 · Reject a radius past the 5 mile cap",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description: `Five miles is roughly twelve minutes of pickup ETA, which is the edge of what a
waiting rider tolerates. Anything beyond it is refused in code, not left to
whoever is editing the panel.`,
        body: { dispatchRadiusLadderMiles: [1, 2, 10] },
        test: rejected("A 10 mile ring is refused"),
      },
    ),

    request(
      "05 · Reject a descending ladder",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "Rings must widen. A descending list would search backwards.",
        body: { dispatchRadiusLadderMiles: [5, 2] },
        test: rejected("A descending ladder is refused"),
      },
    ),

    request(
      "06 · Reject an empty ladder",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "No rings means no search at all — every request would expire unassigned.",
        body: { dispatchRadiusLadderMiles: [] },
        test: rejected("An empty ladder is refused"),
      },
    ),

    request(
      "07 · Reject a repeated radius",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "A repeat is not a wider ring: the second pass would find nobody new.",
        body: { dispatchRadiusLadderMiles: [1, 1, 2] },
        test: rejected("A repeated radius is refused"),
      },
    ),

    request(
      "08 · Reject an impatient ring timeout",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "One second is shorter than a driver can realistically answer in.",
        body: { dispatchRingTimeoutSeconds: 1 },
        test: rejected("A 1 second ring is refused"),
      },
    ),

    request(
      "09 · Reject a fractional ring timeout",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description:
          "The timeout is whole seconds; fractions are refused rather than rounded silently.",
        body: { dispatchRingTimeoutSeconds: 7.5 },
        test: rejected("7.5 seconds is refused"),
      },
    ),

    request(
      "10 · Restore the default ladder",
      "PATCH",
      "/admin/ride-configuration",
      {
        auth: "admin",
        description: "Puts the environment back the way the run found it.",
        body: {
          dispatchRadiusLadderMiles: [1, 2, 3, 5],
          dispatchRingTimeoutSeconds: 10,
        },
        test: [
          ...ok2xx("Restored"),
          "pm.test('Back to 1-2-3-5 at 10 seconds', () => {",
          "  const config = pm.response.json().data;",
          "  pm.expect(config.dispatchRadiusLadderMiles).to.eql([1, 2, 3, 5]);",
          "  pm.expect(config.dispatchRingTimeoutSeconds).to.eql(10);",
          "});",
        ],
      },
    ),

    request(
      "11 · The offers endpoint is gone",
      "POST",
      "/rides/000000000000000000000000/offers",
      {
        auth: "admin",
        description: `The rider used to fetch a list of driver offers and pick one. That flow is
retired, so the route no longer exists and the server answers with its
catch-all 404.

A 200 here would mean the old flow is still reachable.`,
        test: [
          "pm.test('The route no longer exists', () => pm.expect(pm.response.code).to.eql(404));",
          "pm.test('It is the catch-all, not a business 404', () => {",
          "  pm.expect(pm.response.json().message).to.include('Can');",
          "});",
        ],
      },
    ),

    request(
      "12 · Fare quote for the socket request",
      "POST",
      "/rides/fare-calculator",
      {
        description: `Produces the \`rideFare\` you send on \`ride:request:create\`. Run it signed in as
a rider, then carry the number into the socket scenarios in the test plan.`,
        body: { rideType: "economy", miles: 4.2, pickupCity: "Miami" },
        test: [
          "// Needs a rider token. The rest of this folder runs as an admin, so",
          "// this step is skipped unless a rider has been signed in first.",
          "if (pm.response.code === 401) {",
          "  pm.test.skip('No rider token — run Auth > Verify OTP as a rider first');",
          "} else {",
          "  pm.test('Quote returned', () => pm.expect(pm.response.code).to.eql(200));",
          "",
          "  const payload = pm.response.json().data;",
          "  const fare = payload?.fare ?? payload?.rideFare ?? payload?.total;",
          "",
          "  pm.test('The quote is a usable amount', () => {",
          "    const value = Number(fare);",
          "    pm.expect(Number.isFinite(value), JSON.stringify(payload)).to.eql(true);",
          "    pm.expect(value).to.be.above(0);",
          "  });",
          "",
          "  if (Number.isFinite(Number(fare))) setVar('quotedFare', String(fare));",
          "}",
        ],
      },
    ),

    request(
      "13 · Driver list excludes retired private rides",
      "GET",
      "/rides",
      {
        auth: "driver",
        description: `The pull side of dispatch. Needs a **driver** token and a driver who is online
and has sent a location, otherwise it answers \`DRIVER_IS_OFFLINE\` — which is a
correct response, just not a useful one for this check.

What matters is that no \`private\` ride comes back: that type is retired.`,
        query: [{ key: "status", value: "requested" }, ...PAGINATION],
        test: [
          "// Needs a driver token and a driver who is online with a location on",
          "// file. Without either, the endpoint is right to refuse — so the check",
          "// is skipped rather than reported as a failure of the change.",
          "if (pm.response.code === 401) {",
          "  pm.test.skip('No driver token — sign a driver in first');",
          "} else if (pm.response.code === 400) {",
          "  pm.test.skip('Driver is offline — bring one online to exercise this');",
          "} else {",
          "  pm.test('Responded', () => pm.expect(pm.response.code).to.eql(200));",
          "  pm.test('No private rides are offered', () => {",
          "    const rides = pm.response.json().data || [];",
          "    const priv = rides.filter((r) => r.rideType === 'private');",
          "    pm.expect(priv.length, JSON.stringify(priv)).to.eql(0);",
          "  });",
          "}",
        ],
      },
    ),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
   Standalone test collection (repository root)

   Self-contained: its own variables, in running order, nothing to import
   alongside it. Written in Spanish because it pairs with
   PLAN_DE_PRUEBAS_DESPACHO.md and is used by the team day to day.
   ──────────────────────────────────────────────────────────────────────────*/

const rechazado = (label) => [
  `pm.test("${label}", () => {`,
  "  pm.expect(pm.response.code, 'no debería aceptarse').to.be.within(400, 499);",
  "});",
  "pm.test('El error explica el motivo', () => {",
  "  const body = pm.response.json();",
  "  pm.expect(body.success).to.eql(false);",
  "  pm.expect(body.message, JSON.stringify(body)).to.be.a('string').and.not.empty;",
  "});",
];

const aceptado = (label) => [
  `pm.test("${label}", () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));`,
];

const optionalLogin = (who, tokenVar) => [
  "const body = pm.response.json();",
  "const token = body?.data?.token;",
  "",
  "if (token) {",
  `  setVar('${tokenVar}', token);`,
  `  pm.test('Token de ${who} guardado', () => pm.expect(token).to.be.a('string'));`,
  "} else {",
  `  pm.test.skip('Sin token de ${who}: ' + (body?.message || 'cuenta no habilitada'));`,
  "}",
];

const testsCollection = {
  info: {
    _postman_id: "e91c4f20-7b3a-4f6d-9c21-000000000002",
    name: "RideShare — Pruebas de las modificaciones",
    description: `Colección enfocada en **probar los cambios del despacho**, no en documentar toda
la API. Para eso está \`postman/RideShare-API.postman_collection.json\`, que
tiene los 144 endpoints.

## Cómo correrla

1. Levantá el stack local y sembrá el admin:

   \`\`\`
   docker compose -f docker-compose.local.yml up -d
   docker compose -f docker-compose.local.yml exec app-local npm run seed:admin
   \`\`\`

2. Abrí el **Collection Runner**, seleccioná esta colección entera y corré.

No hace falta importar ningún entorno: \`baseUrl\` ya viene apuntando a
\`http://localhost:3000/api\`. Si querés probar contra otro ambiente, cambiá esa
variable en **Variables**.

**Resultado esperado: 25 aserciones en verde.** Los pasos que necesitan un token
de rider o de driver se saltan solos si no lo conseguiste — eso cuenta como
correcto, no como fallo.

## Qué cubre y qué no

| Cubre | No cubre |
|---|---|
| La escalera de radios y sus límites | El escalonamiento en vivo |
| Que el tope de 5 millas no se pueda saltar | La carrera entre dos drivers |
| Que el flujo de ofertas esté retirado | El arranque de un viaje gratuito |
| Que el listado del driver no traiga \`private\` | La expiración por búsqueda agotada |

Todo lo de la derecha corre sobre **Socket.IO**, que Postman no puede
automatizar dentro de una colección. Esos once escenarios están escritos paso a
paso en **\`PLAN_DE_PRUEBAS_DESPACHO.md\`**, en la raíz del repositorio, con el
payload exacto y los eventos que tenés que ver. La carpeta 4 de acá los resume.

> Corré esto contra **Local**. Modifica la configuración de distancias y crea
> datos. En dev y staging la base es compartida; en producción son clientes
> reales.`,
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: {
    type: "bearer",
    bearer: [{ key: "token", value: "{{token}}", type: "string" }],
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:3000/api", type: "string" },
    { key: "socketUrl", value: "ws://localhost:3000", type: "string" },
    { key: "adminEmail", value: "admin@example.com", type: "string" },
    { key: "adminPassword", value: "Admin@123", type: "string" },
    { key: "riderPhone", value: "3055550123", type: "string" },
    { key: "driverPhone", value: "3055550124", type: "string" },
    { key: "testOtp", value: "123456", type: "string" },
    { key: "token", value: "", type: "string" },
    { key: "driverToken", value: "", type: "string" },
    { key: "adminToken", value: "", type: "string" },
    { key: "quotedFare", value: "", type: "string" },
  ],
  item: [
    folder(
      "0 · Preparación",
      `El login de admin es **obligatorio**: sin él, toda la carpeta 1 devuelve 401.

Los de rider y driver son opcionales. Si la cuenta no está onboardeada el
servidor devuelve \`token: null\`, que no es un error sino la compuerta — los
pasos que dependan de ese token se saltarán solos.

Las credenciales salen de variables (\`adminEmail\`, \`riderPhone\`…), así que se
cambian en un solo lugar.`,
      [
        request("00 · Login de admin", "POST", "/admin/login", {
          auth: "none",
          description: `Obtiene el token de back office y lo guarda en \`adminToken\`.

Las credenciales por defecto son las que crea \`npm run seed:admin\` en local. En
otro ambiente cambiá las variables \`adminEmail\` y \`adminPassword\`.`,
          body: { email: "{{adminEmail}}", password: "{{adminPassword}}" },
          test: [
            "const body = pm.response.json();",
            "const token = body?.data?.token;",
            "pm.test('Login de admin correcto', () => pm.expect(token, body?.message).to.be.a('string'));",
            "if (token) setVar('adminToken', token);",
          ],
        }),
        request("01 · Rider · Enviar OTP", "POST", "/auth/send-otp", {
          auth: "none",
          description:
            "Opcional. Crea o encuentra la cuenta del rider. En local no se envía SMS: el código es el de `testOtp`.",
          body: { phone: "{{riderPhone}}", role: "user", locale: "es" },
          test: [
            "pm.test('OTP solicitado', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));",
          ],
        }),
        request("02 · Rider · Verificar OTP", "POST", "/auth/verify-otp", {
          auth: "none",
          description: `Opcional. Guarda el token del rider en \`token\`.

Si la cuenta no completó el onboarding devuelve \`token: null\` y el paso se
salta. En local el onboarding necesita una clave de prueba de Stripe.`,
          body: {
            phone: "{{riderPhone}}",
            otp: "{{testOtp}}",
            role: "user",
            locale: "es",
          },
          test: optionalLogin("rider", "token"),
        }),
        request("03 · Driver · Enviar OTP", "POST", "/auth/send-otp", {
          auth: "none",
          description:
            "Opcional. Lo mismo que el rider, pero con rol `driver`.",
          body: { phone: "{{driverPhone}}", role: "driver", locale: "es" },
          test: [
            "pm.test('OTP solicitado', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));",
          ],
        }),
        request("04 · Driver · Verificar OTP", "POST", "/auth/verify-otp", {
          auth: "none",
          description: `Opcional. Guarda el token del driver en \`driverToken\`.

Un driver sin documentos aprobados recibe \`token: null\` — esa es la compuerta,
no un error.`,
          body: {
            phone: "{{driverPhone}}",
            otp: "{{testOtp}}",
            role: "driver",
            locale: "es",
          },
          test: optionalLogin("driver", "driverToken"),
        }),
      ],
    ),

    folder(
      "1 · Escalera de radios",
      `El núcleo de la prueba. La búsqueda ya no usa un radio fijo de 5 millas: abre
anillos de 1, 2, 3 y 5, uno cada diez segundos, y se detiene apenas alguien
acepta.

Esta carpeta comprueba los valores por defecto y, sobre todo, que **el tope de 5
millas no se pueda saltar desde el panel**. Cinco millas son unos doce minutos de
ETA al punto de recogida, que es el borde de lo que un rider tolera antes de
cancelar; pasarse es una decisión de producto, así que está bloqueado en código.

El último paso restaura los valores por defecto: la corrida deja el ambiente como
lo encontró.`,
      [
        request(
          "10 · Leer la configuración",
          "GET",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description: `Debe traer la escalera con sus valores por defecto. En una base que nunca los
tuvo, el servicio los rellena en esta primera lectura.`,
            test: [
              "const config = pm.response.json().data;",
              "",
              "pm.test('La escalera existe', () => {",
              "  pm.expect(config.dispatchRadiusLadderMiles, JSON.stringify(config)).to.be.an('array').that.is.not.empty;",
              "});",
              "",
              "pm.test('Arranca en 1 milla y termina en el tope de 5', () => {",
              "  const l = config.dispatchRadiusLadderMiles;",
              "  pm.expect(l[0]).to.eql(1);",
              "  pm.expect(l[l.length - 1]).to.eql(5);",
              "});",
              "",
              "pm.test('Los anillos son estrictamente ascendentes', () => {",
              "  const l = config.dispatchRadiusLadderMiles;",
              "  l.forEach((r, i) => { if (i) pm.expect(r, `anillo ${i}`).to.be.above(l[i - 1]); });",
              "});",
              "",
              "pm.test('El timeout es un número entero de segundos', () => {",
              "  pm.expect(config.dispatchRingTimeoutSeconds).to.be.a('number');",
              "  pm.expect(config.dispatchRingTimeoutSeconds % 1).to.eql(0);",
              "});",
            ],
          },
        ),
        request(
          "11 · Aceptar una escalera más cerrada",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "Válida: ascendente y dentro del tope. Sirve para zonas densas.",
            body: {
              dispatchRadiusLadderMiles: [0.5, 1, 2],
              dispatchRingTimeoutSeconds: 8,
            },
            test: [
              ...aceptado("Aceptada"),
              "pm.test('Devuelve la escalera nueva', () => {",
              "  pm.expect(pm.response.json().data.dispatchRadiusLadderMiles).to.eql([0.5, 1, 2]);",
              "});",
            ],
          },
        ),
        request(
          "12 · Rechazar un radio mayor a 5 millas",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "Diez millas son unos 24 minutos de ETA. Si esto devuelve 200, el tope se rompió.",
            body: { dispatchRadiusLadderMiles: [1, 2, 10] },
            test: rechazado("Un anillo de 10 millas se rechaza"),
          },
        ),
        request(
          "13 · Rechazar una escalera descendente",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "Los anillos tienen que abrirse. Una lista descendente buscaría hacia atrás.",
            body: { dispatchRadiusLadderMiles: [5, 2] },
            test: rechazado("Una escalera descendente se rechaza"),
          },
        ),
        request(
          "14 · Rechazar una escalera vacía",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "Sin anillos no hay búsqueda: todos los pedidos expirarían sin asignar.",
            body: { dispatchRadiusLadderMiles: [] },
            test: rechazado("Una escalera vacía se rechaza"),
          },
        ),
        request(
          "15 · Rechazar un radio repetido",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "Un repetido no es un anillo más ancho: la segunda pasada no encontraría a nadie nuevo.",
            body: { dispatchRadiusLadderMiles: [1, 1, 2] },
            test: rechazado("Un radio repetido se rechaza"),
          },
        ),
        request(
          "16 · Rechazar un timeout de 1 segundo",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description: "Más corto de lo que un driver alcanza a responder.",
            body: { dispatchRingTimeoutSeconds: 1 },
            test: rechazado("Un anillo de 1 segundo se rechaza"),
          },
        ),
        request(
          "17 · Rechazar un timeout fraccionario",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description:
              "El timeout es en segundos enteros; se rechaza en vez de redondear en silencio.",
            body: { dispatchRingTimeoutSeconds: 7.5 },
            test: rechazado("7,5 segundos se rechaza"),
          },
        ),
        request(
          "18 · Restaurar los valores por defecto",
          "PATCH",
          "/admin/ride-configuration",
          {
            auth: "admin",
            description: "Deja el ambiente como estaba antes de la corrida.",
            body: {
              dispatchRadiusLadderMiles: [1, 2, 3, 5],
              dispatchRingTimeoutSeconds: 10,
            },
            test: [
              ...aceptado("Restaurada"),
              "pm.test('Vuelve a 1-2-3-5 con 10 segundos', () => {",
              "  const c = pm.response.json().data;",
              "  pm.expect(c.dispatchRadiusLadderMiles).to.eql([1, 2, 3, 5]);",
              "  pm.expect(c.dispatchRingTimeoutSeconds).to.eql(10);",
              "});",
            ],
          },
        ),
      ],
    ),

    folder(
      "2 · Flujo de ofertas retirado",
      `El rider ya no elige driver de una lista. Ahora pide y espera, y gana el primero
que acepta.

Estas dos pruebas confirman que el flujo viejo quedó cerrado.`,
      [
        request(
          "20 · El endpoint de ofertas ya no existe",
          "POST",
          "/rides/000000000000000000000000/offers",
          {
            auth: "admin",
            description: `El rider usaba esta ruta para traer las ofertas de los drivers y elegir una. Está
retirada, así que el servidor responde con su 404 general.

Un 200 acá querría decir que el flujo viejo sigue alcanzable.`,
            test: [
              "pm.test('La ruta ya no existe', () => pm.expect(pm.response.code).to.eql(404));",
              "pm.test('Es el 404 general, no uno de negocio', () => {",
              "  pm.expect(pm.response.json().message).to.include('Can');",
              "});",
            ],
          },
        ),
        request(
          "21 · El listado del driver no trae viajes private",
          "GET",
          "/rides",
          {
            auth: "driver",
            description: `El lado de consulta del despacho: por acá un driver que se conecta tarde
encuentra pedidos abiertos.

Necesita token de driver y que esté online con una ubicación enviada. Si no, el
endpoint responde \`DRIVER_IS_OFFLINE\`, que es correcto — el paso se salta.`,
            query: [{ key: "status", value: "requested" }, ...PAGINATION],
            test: [
              "if (pm.response.code === 401) {",
              "  pm.test.skip('Sin token de driver: corré el paso 04 primero');",
              "} else if (pm.response.code === 400) {",
              "  pm.test.skip('El driver está offline: ponelo online y mandá una ubicación');",
              "} else {",
              "  pm.test('Responde', () => pm.expect(pm.response.code).to.eql(200));",
              "  pm.test('No se ofrecen viajes private', () => {",
              "    const rides = pm.response.json().data || [];",
              "    const priv = rides.filter((r) => r.rideType === 'private');",
              "    pm.expect(priv.length, JSON.stringify(priv)).to.eql(0);",
              "  });",
              "}",
            ],
          },
        ),
      ],
    ),

    folder(
      "3 · Tarifa para los escenarios de socket",
      `El número que necesitás para armar el \`ride:request:create\` de la carpeta 4.
Mandá el mismo valor que te devuelve acá, así al rider se le cobra lo que se le
mostró.`,
      [
        request(
          "30 · Calculadora de tarifa",
          "POST",
          "/rides/fare-calculator",
          {
            description: `Cotiza un viaje antes de pedirlo. Guarda el resultado en \`quotedFare\`.

\`pickupCity\` es opcional: si la ciudad tiene tarifario propio se usa ese, si no
el global. Los multiplicadores de hora pico ya vienen aplicados.`,
            body: { rideType: "economy", miles: 4.2, pickupCity: "Miami" },
            test: [
              "if (pm.response.code === 401) {",
              "  pm.test.skip('Sin token de rider: corré el paso 02 primero');",
              "} else {",
              "  pm.test('Devuelve cotización', () => pm.expect(pm.response.code).to.eql(200));",
              "",
              "  const payload = pm.response.json().data;",
              "  const fare = payload?.fare ?? payload?.rideFare ?? payload?.total;",
              "",
              "  pm.test('Es un monto usable', () => {",
              "    const value = Number(fare);",
              "    pm.expect(Number.isFinite(value), JSON.stringify(payload)).to.eql(true);",
              "    pm.expect(value).to.be.above(0);",
              "  });",
              "",
              "  if (Number.isFinite(Number(fare))) setVar('quotedFare', String(fare));",
              "}",
            ],
          },
        ),
      ],
    ),

    folder(
      "4 · Escenarios de socket (manual)",
      `Lo que Postman no puede automatizar. Estos once escenarios están desarrollados
con todo el detalle en **\`PLAN_DE_PRUEBAS_DESPACHO.md\`**, en la raíz del
repositorio; acá va el resumen para tenerlo a mano.

### Conectarse

**New → Socket.IO**, URL \`{{socketUrl}}\`, y en **Settings → Handshake**:

\`\`\`json
{ "auth": { "token": "<el token de verify-otp>" } }
\`\`\`

El servidor lee el rol desde el token.

### Pedido del rider

\`\`\`json
{
  "category": "economy",
  "pickupPoint": { "placeName": "Brickell", "location": { "type": "Point", "coordinates": [-80.1918, 25.7617] } },
  "dropOffPoint": { "placeName": "Wynwood", "location": { "type": "Point", "coordinates": [-80.1994, 25.8010] } },
  "rideDistance": 4.2,
  "rideFare": {{quotedFare}},
  "averageTime": 12,
  "paymentMethod": "wallet"
}
\`\`\`

### Los once escenarios

| # | Qué probás | Resultado esperado |
|---|---|---|
| S1 | Driver a 0,5 mi | Asigna en el anillo 1, sin escalar |
| S2 | Único driver a 4,5 mi | Tres \`ride:search:status\` y asigna en el anillo 4 |
| S3 | Ningún driver | Cuatro status, \`ride:search:exhausted\`, viaje a \`expired\` |
| S4 | Dos drivers aceptan a la vez | Uno gana; el otro recibe \`ride:request:taken\` con su lista |
| S5 | \`category: "carpool"\` | Redirige al matching de rutas y **no crea viaje** |
| S6 | Sin categoría / \`private\` | Error de validación; \`rideType\` viejo sí se acepta |
| S7 | Gratis con promo | Arranca sin llamar a Stripe y el driver cobra la tarifa original |
| S8 | Gratis sin promo | **El driver cobra 0** — decisión de producto pendiente |
| S9 | Un driver, cuatro anillos | Recibe el pedido **una sola vez** |
| S10 | Cancelar a media búsqueda | Se detiene la escalera; queda \`cancelled\`, no \`expired\` |
| S11 | Reconectar a media búsqueda | Sigue recibiendo el progreso |

### Para sembrar drivers a distancias conocidas

\`\`\`
docker compose -f docker-compose.local.yml exec app-local node scripts/verify-dispatch.js
\`\`\`

Siembra, camina la escalera anillo por anillo, comprueba la expiración y limpia
lo que creó.`,
      [],
    ),
  ],
};

/* ────────────────────────────────────────────────────────────────────────────
   Collection
   ──────────────────────────────────────────────────────────────────────────*/

const collection = {
  info: {
    _postman_id: "e91c4f20-7b3a-4f6d-9c21-000000000001",
    name: "RideShare — Backend API",
    description: `Complete API surface of the RideShare backend.

## Environments

Import all four and pick one from the selector. Each sets \`baseUrl\` and
\`socketUrl\` for you.

| Environment | API root | Database | SMS / email |
|---|---|---|---|
| **Local** | \`http://localhost:3000/api\` | Mongo in a container | Off — fixed OTP |
| **Dev** | \`https://api.dev.example.com/api\` | Atlas \`rideshare-dev\`, shared | **Live** |
| **Staging** | \`https://api.staging.example.com/api\` | Atlas, shared | **Live** |
| **Production (LIVE)** | \`https://api.example.com/api\` | Atlas | **Live** |

The deployed hostnames are placeholders — replace them with your own deployment.

**Running an environment on your own machine instead.** Each compose file binds
a different port, so several can run at once. Every environment carries a
disabled \`baseUrlDocker\` variable with the right one — enable it and copy it
into \`baseUrl\`:

| Compose file | Local port |
|---|---|
| \`docker-compose.local.yml\` | \`http://localhost:3000/api\` |
| \`docker-compose.dev.yml\` | \`http://localhost:3001/api\` |
| \`docker-compose.staging.yml\` | \`http://localhost:3002/api\` |
| \`docker-compose.prod.yml\` | \`http://localhost:3000/api\` (clashes with Local) |

> **Production is live.** Real riders, real drivers, real money and real SMS.
> Anything you write there reaches a customer. Keep to read-only calls unless
> you were asked for something specific.

## Start here

1. Pick an environment.
2. Run **1. Auth → Send OTP**, then **Verify OTP**. The token is captured into a
   collection variable automatically; every other request uses it.
3. For the back office, run **12. Admin → Admin login** — that fills
   \`adminToken\` separately.

The OTP bypass only exists where \`TEST_OTP\` is set, which is Local (\`123456\`,
held in the \`testOtp\` variable). On dev, staging and production it is unset, so
the code arrives by **real SMS** — use a phone you actually own.

## What is not here

**The ride lifecycle is Socket.IO, not HTTP.** Requesting, accepting, arriving,
starting and completing a ride are all socket events. Folder **14** documents
every one of them with payloads — read it before wiring a client.

## Conventions

- **Every route is mounted under \`/api\`**, which is already part of
  \`baseUrl\`. The server's own boot log prints paths without it — if you copy a
  path from the console you will get a 404.
- Every response is wrapped: \`{ success, message, data }\`, plus \`pagination\`
  on list endpoints.
- Errors are \`{ success: false, message }\` with a meaningful HTTP status.
- Coordinates in ride and carpool APIs are GeoJSON — **\`[longitude, latitude]\`**,
  in that order. Saved user locations are the exception and use \`{ lat, lng }\`.
- Money is USD.
- \`locale\` is \`en\` or \`es\` and changes the language of server messages.

## Tokens

Three separate variables so you can keep three sessions open at once:
\`token\` (rider), \`driverToken\` (driver), \`adminToken\` (back office).

Generated from the route files by \`scripts/generate-postman-collection.js\`.
Regenerate it rather than editing this JSON by hand.`,
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: {
    type: "bearer",
    bearer: [{ key: "token", value: "{{token}}", type: "string" }],
  },
  event: [
    {
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: [
          "// Warn early instead of letting a request fail with a confusing 401.",
          "const needsAuth = pm.request.auth?.type !== 'noauth';",
          "if (needsAuth && !pm.collectionVariables.get('token') && !pm.collectionVariables.get('adminToken')) {",
          "  console.log('No token set yet — run Auth > Verify OTP, or Admin > Admin login.');",
          "}",
        ],
      },
    },
  ],
  variable: [
    // Every route is mounted under /api (see routeAdder in
    // src/core/common/helpers/index.js). The boot log prints paths without it,
    // which is an easy way to end up with 404s.
    { key: "baseUrl", value: "http://localhost:3000/api", type: "string" },
    // Sockets are not under /api — they attach to the server root.
    { key: "socketUrl", value: "ws://localhost:3000", type: "string" },
    { key: "token", value: "", type: "string" },
    { key: "driverToken", value: "", type: "string" },
    { key: "adminToken", value: "", type: "string" },
    { key: "userId", value: "", type: "string" },
    { key: "driverId", value: "", type: "string" },
    { key: "rideId", value: "", type: "string" },
    { key: "id", value: "", type: "string" },
    { key: "card", value: "", type: "string" },
    { key: "bankId", value: "", type: "string" },
    { key: "locationId", value: "", type: "string" },
    { key: "documentId", value: "", type: "string" },
    { key: "reviewId", value: "", type: "string" },
    { key: "reportId", value: "", type: "string" },
    { key: "notificationId", value: "", type: "string" },
    { key: "subscriptionId", value: "", type: "string" },
    { key: "priceId", value: "", type: "string" },
    { key: "contextId", value: "", type: "string" },
    { key: "campaignId", value: "", type: "string" },
    { key: "journeyType", value: "ride", type: "string" },
    { key: "journeyId", value: "", type: "string" },
    { key: "rideType", value: "economy", type: "string" },
    { key: "role", value: "user", type: "string" },
    { key: "status", value: "pending", type: "string" },
    { key: "type", value: "profile", type: "string" },
    { key: "source", value: "main", type: "string" },
    { key: "quotedFare", value: "", type: "string" },
    { key: "ladderBackup", value: "", type: "string" },
  ],
  item: [
    authFolder,
    userFolder,
    driverFolder,
    rideFolder,
    carpoolFolder,
    reviewFolder,
    reportFolder,
    notificationFolder,
    chatFolder,
    subscriptionFolder,
    miscFolder,
    adminFolder,
    webhookFolder,
    socketFolder,
    testPlanFolder,
  ],
};

/**
 * One Postman environment per deployment.
 *
 * The deployed hostnames (api.example.com, api.staging.example.com and
 * api.dev.example.com) are placeholders — point them at your own deployment.
 *
 * `baseUrlDocker` is the same environment run on your own machine with its
 * compose file; the port differs per file so several can run side by side.
 */
const ENVIRONMENTS = [
  {
    id: "rideshare-env-local",
    name: "RideShare — Local",
    baseUrl: "http://localhost:3000/api",
    socketUrl: "ws://localhost:3000",
    baseUrlDocker: "http://localhost:3000/api",
    compose: "docker-compose.local.yml",
    testOtp: "123456",
    note: "Self-contained stack: Mongo and Redis in containers, toy data, no real SMS or email.",
  },
  {
    id: "rideshare-env-dev",
    name: "RideShare — Dev",
    baseUrl: "https://api.dev.example.com/api",
    socketUrl: "wss://api.dev.example.com",
    baseUrlDocker: "http://localhost:3001/api",
    compose: "docker-compose.dev.yml",
    testOtp: "",
    note: "Shared Atlas database. Twilio and SendGrid are live: OTPs arrive by real SMS and TEST_OTP is unset.",
  },
  {
    id: "rideshare-env-staging",
    name: "RideShare — Staging",
    baseUrl: "https://api.staging.example.com/api",
    socketUrl: "wss://api.staging.example.com",
    baseUrlDocker: "http://localhost:3002/api",
    compose: "docker-compose.staging.yml",
    testOtp: "",
    note: "Shared Atlas database, pre-release. Treat data as if it were real.",
  },
  {
    id: "rideshare-env-production",
    name: "RideShare — Production (LIVE)",
    baseUrl: "https://api.example.com/api",
    socketUrl: "wss://api.example.com",
    baseUrlDocker: "http://localhost:3000/api",
    compose: "docker-compose.prod.yml",
    testOtp: "",
    note: "LIVE. Real riders, real drivers, real money and real SMS. Every write here reaches a customer. Read-only calls only, unless you have been asked for something specific.",
  },
];

const buildEnvironment = (env) => ({
  id: env.id,
  name: env.name,
  values: [
    {
      key: "baseUrl",
      value: env.baseUrl,
      enabled: true,
      type: "default",
      description: `API root for ${env.name}. ${env.note}`,
    },
    {
      key: "socketUrl",
      value: env.socketUrl,
      enabled: true,
      type: "default",
      description:
        "Socket.IO endpoint. Not under /api — it attaches to the server root.",
    },
    {
      key: "baseUrlDocker",
      value: env.baseUrlDocker,
      enabled: false,
      type: "default",
      description: `Same environment run locally with ${env.compose}. Copy this into baseUrl to point at your own machine instead of the deployed host.`,
    },
    { key: "token", value: "", enabled: true, type: "secret" },
    { key: "driverToken", value: "", enabled: true, type: "secret" },
    { key: "adminToken", value: "", enabled: true, type: "secret" },
    {
      key: "testOtp",
      value: env.testOtp,
      enabled: true,
      type: "default",
      description: env.testOtp
        ? "TEST_OTP for this environment: the OTP bypass, so no SMS is sent."
        : "TEST_OTP is not set here — the OTP arrives by real SMS.",
    },
  ],
  _postman_variable_scope: "environment",
});

/* ── Write ─────────────────────────────────────────────────────────────────*/

function countRequests(items) {
  return items.reduce(
    (total, item) => total + (item.item ? countRequests(item.item) : 1),
    0,
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const collectionPath = path.join(
  OUT_DIR,
  "RideShare-API.postman_collection.json",
);
fs.writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`Collection:  ${collectionPath}`);

// The focused test collection lives at the repository root, next to the test
// plan it pairs with, so it is the first thing someone opening the repo finds.
const testsPath = path.join(
  ROOT_DIR,
  "RideShare-Pruebas.postman_collection.json",
);
fs.writeFileSync(testsPath, `${JSON.stringify(testsCollection, null, 2)}\n`);
console.log(`Tests:       ${testsPath}`);

for (const env of ENVIRONMENTS) {
  const slug = env.name
    .replace(/^RideShare — /, "")
    .replace(/\s*\(LIVE\)/, "")
    .trim()
    .replace(/\s+/g, "-");

  const envPath = path.join(
    OUT_DIR,
    `RideShare-${slug}.postman_environment.json`,
  );

  fs.writeFileSync(
    envPath,
    `${JSON.stringify(buildEnvironment(env), null, 2)}\n`,
  );
  console.log(`Environment: ${envPath}  →  ${env.baseUrl}`);
}

console.log(`Folders:  ${collection.item.length}`);
console.log(`Requests: ${countRequests(collection.item)}`);

# January switch-on checklist (LR6)

Master plan §12 LR6 and §11b (owner 2026-11-05: outside services stay off until close to launch, then one at a time,
each verified with a test company). Prepared 2026-11-14; **everything below is still off** unless its row says
otherwise. Variable names come from `src/server/env.ts`, `src/server/ai/`, `src/server/routing/service.ts`,
`src/server/passkeys.ts`, docs/SETUP.md §1, docs/DEPLOYMENT.md §2 and docs/AI.md §3. Values are never written here,
never pasted in a chat and never committed.

Live address: **https://www.mytaviron.com** (owner decision 2026-11-14).

## How every switch-on goes

1. **One service at a time**, in the order below unless the owner decides otherwise.
2. **Who:** the owner creates the account, accepts its terms and pays where it costs money, and types every key into
   the service's own dashboard or into Vercel (Settings → Environment Variables → Production; tick **Sensitive** for
   keys). Claude prepares the steps, checks the result and records it. Approval for one service never covers another.
3. **After any Vercel variable change:** Deployments → the current Production deployment → **Redeploy**. Nothing
   changes before the redeploy.
4. **Verify with the test company first** (below), then with Top Line, then for outside customers.
5. **Record it:** date, who, how it was verified, in the table at the end, in docs/LEGAL_REVIEW_PACKET.md §5 (the
   service becomes **On**) and in the master plan.

**The test company** (make it once, early January): a real, non-demo company, because demo companies never send,
connect or call anything (docs/DEMO_TENANTS.md §2). Create it like any company (docs/DEPLOYMENT.md §3:
`private.create_company` and `scripts/create-owner.mjs`), give it fictional customers, trucks and one driver, use
email addresses and a phone the owner controls, then mark it **Practice / test** in the platform console (master plan
B67) so it stays out of counts and can be deleted later.

## 1. App email (Resend)

| | |
| --- | --- |
| Status | Planned **before Dec 1** for Top Line (docs/LAUNCH.md step 8). |
| Who / where | Owner: Resend → API Keys; Vercel Production. |
| Variables | `EMAIL_PROVIDER` (`resend`), `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `LEAD_NOTIFY_EMAIL`, `EMAIL_TEST_RECIPIENT` (test mode only), `APP_BASE_URL` (links in emails) |
| Verify | Test mode first (`EMAIL_TEST_RECIPIENT` set): Settings → Email shows **Test**; **Email quote** reaches the test inbox with `[TEST]`. Then remove it: **Live**; one quote to the owner's own address. A demo company still says "Demo company: emails are shown, never sent." |
| Off | `EMAIL_PROVIDER` = `preview` (or delete it), redeploy. Every attempt is then recorded as a preview. |
| Before outside customers | **Code change needed (not built):** `EMAIL_REPLY_TO` is one address for every company and also for website lead confirmations, so replies to one customer company's quotes and invoices would reach whoever reads that inbox. Each company needs its own reply address (for example its company email from Settings). The daily summary and subscription notices go to each company's owners once email is live. |

## 2. Text messages (Twilio)

| | |
| --- | --- |
| Status | Built, off. The only texts are **two-step verification codes**, sent by Supabase Auth through Twilio (B109, DEPLOYMENT §3d). Taviron itself sends no text messages: texts for hired-truck offers (B83) and the daily summary are **not built**. |
| Lead time | US carriers only deliver business texts from a registered sender: a 10DLC brand and campaign registration for a local number, or verification of a toll-free number. Twilio's review is not instant and can take weeks, and it usually asks for the business's legal name and tax number, so it follows the LLC (legal packet §12 Q1). **Start the registration in December** and leave everything else off. |
| Who / where | Owner: Twilio console (account, number or Messaging Service, registration); Supabase → Authentication → Providers → **Phone** (Twilio: Account SID, Auth Token, Messaging Service SID; these stay in Supabase); Supabase → Authentication → Multi-Factor → **Phone** on; Vercel. |
| Variables | `MFA_SMS` = `on` (Vercel). Twilio's values go in Supabase only, never in Vercel. |
| Verify | In the test company, a person sets up two-step verification: "No authenticator app? Get codes by text message" appears; the code arrives on the owner's phone and signs in. Each text costs money (Twilio pricing). |
| Off | Ask anyone using texts to switch to an authenticator app, then `MFA_SMS` = `off` and redeploy, then turn Phone off in Supabase. (With `MFA_SMS=off` alone, people who chose texts can still sign in with them.) |

## 3. QuickBooks Online (production app)

| | |
| --- | --- |
| Status | Built, off. Owner is creating the free Intuit sandbox (SESSION_HANDOFF 2026-11-12). Sending payments recorded by ticket to QuickBooks (TP1 slice 3) is **not built** yet. |
| Lead time | Intuit issues production keys only after the app's production settings are filled in on developer.intuit.com (company details, the app's host domain, and public links to its privacy policy and end-user terms) and Intuit's review. Those links must open for Intuit: `/privacy` and `/terms` are behind the early-access gate until `PUBLIC_SITE=on` (item 8), and they should be the lawyer's final versions (LR5). Start the production request as soon as both are ready. |
| Who / where | Owner: developer.intuit.com (app, keys, redirect URI); Vercel. |
| Variables | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (`sandbox` first, then `production`); `APP_BASE_URL` must be `https://www.mytaviron.com`, and Intuit's redirect URI must be exactly `https://www.mytaviron.com/api/accounting/qbo/callback`. `SUPABASE_SERVICE_ROLE_KEY` (already set) stores the tokens. |
| Verify | DEPLOYMENT §2d: Billing → Businesses and QuickBooks → **Connect QuickBooks** with the sandbox company, choose the product for invoice lines, send one handed-off order of the test company, find the invoice in the sandbox. Then `production`, redeploy, connect each business's real QuickBooks company again (changing the environment means connecting again). |
| Off | Billing → Businesses and QuickBooks → **Disconnect** for each business; to stop it for everyone, delete the `QBO_*` variables and redeploy. Rotating `QBO_CLIENT_SECRET` makes stored connections unreadable (connect again). Demo companies only simulate sends. |

## 4. AI (OpenAI): Ask Taviron, Explain this plan, Read a ticket photo

| | |
| --- | --- |
| Status | Built, off for real companies: the owner reports the AI variables are set in Vercel (docs/AI.md §16), but no real company is in the allowlist. |
| Evaluation | Each capability needs passing evidence from a real `npm run ai:eval` (GitHub → Actions → "AI evaluation (manual, paid)", repository secret `OPENAI_API_KEY`), copied verbatim into `src/lib/ai/evidence.ts`; never written by hand. Evidence counts for **90 days**: the current evidence is from **2026-10-26** (gpt-5-mini, all three capabilities), so it lapses about **2027-01-24**. Switching on after that, or after the test set changes, needs a new run first (a few cents). |
| Who / where | Owner: OpenAI project (key, spending limit, data settings, docs/AI.md §17); Vercel; Supabase SQL editor (pause switch). Claude: runs nothing paid without the owner; records evidence. |
| Variables | `AI_PROVIDER` (`openai`), `OPENAI_API_KEY`, `AI_CAPABILITIES` (`ops_assistant`, `plan_explanation`, `ticket_reading`), `AI_MODEL_OPS_ASSISTANT`, `AI_MODEL_PLAN_EXPLANATION`, `AI_MODEL_TICKET_READING`, `AI_MONTHLY_TOKEN_LIMIT`, `AI_USER_MONTHLY_TOKEN_LIMIT`, `AI_COMPANY_ALLOWLIST` (company ids), `AI_IN_DEMOS`, `AI_SEND_PHOTOS` (photos to OpenAI, ticket reading only); optional `AI_PRICING_JSON`, `AI_MONTHLY_COST_LIMIT_USD`, `AI_REQUESTS_PER_MINUTE`, `AI_USER_REQUESTS_PER_MINUTE`, `AI_USER_DAILY_REQUESTS`, `AI_TIMEOUT_MS`, `AI_MAX_REQUEST_CHARS`, `AI_FALLBACK_MODEL_*` (only with its own evidence). |
| Verify | Add the test company's id to `AI_COMPANY_ALLOWLIST`, redeploy, open Company setup → AI capabilities: each capability **Ready** or **Limited**, never Needs review. Ask one question per role; check the answer is labelled as AI and changes nothing. Ticket photos: only after the privacy notice mentions them (AI.md §17). Then Top Line, then customers one at a time. |
| Off | Immediately, no redeploy: Supabase SQL editor `update private.ai_controls set paused = true, reason = '<why>', updated_at = now();` (docs/AI.md §16). Longer term: remove the capability from `AI_CAPABILITIES` or the company from `AI_COMPANY_ALLOWLIST` and redeploy, or revoke the key at OpenAI. |

## 5. Truck routing and maps (HERE)

| | |
| --- | --- |
| Status | Built. `ROUTING_IN_DEMOS=on` is recorded as set in Production (master plan §12, 2026-10-26); whether `HERE_API_KEY` is set is **not recorded**. Check Route Planner first: "Road, by HERE" means it is on. |
| Who / where | Owner: HERE developer portal (project, REST API key, usage alerts; check HERE's current free tier and prices); Vercel. docs/ROUTING.md §4. |
| Variables | `ROUTING_PROVIDER` (`here`), `HERE_API_KEY`; optional `ROUTING_IN_DEMOS`, `ROUTING_TIMEOUT_MS`. |
| Verify | In the test company, a truck with dimensions, a yard and a site with a location: Route Planner shows "Road, by HERE" with a driving time. |
| Off | Delete `ROUTING_PROVIDER` (or the key) and redeploy: routes fall back to straight-line distances marked as estimates. |

## 6. GPS and driver hours (ELD)

| | |
| --- | --- |
| Status | Built, off per company. Provider not chosen (owner 2026-10-28, master plan B101/B87); no named provider integration exists (Samsara, Motive, Geotab adapters would be built when a customer asks). |
| Who / where | Each company's owner: Settings → **GPS and hours** (Off / Entered by hand / Provider feed). The feed key is shown once; only its fingerprint is stored. The company's provider (or a connector) sends to `POST https://www.mytaviron.com/api/telematics/ingest` (docs/SETUP.md "GPS and hours provider feed"). During a Taviron support visit the feed key stays owner-only (SA2). |
| Variables | None (per-company key in the database; the route uses `SUPABASE_SERVICE_ROLE_KEY`, already set). |
| Verify | In the test company: Provider feed → create the key → send the sample request from SETUP with that key and one of its truck numbers → Fleet → Locations and hours shows the position; hours show as from the feed. |
| Off | Settings → GPS and hours → **Off** (or create a new key, which replaces the old one). |

## 7. Face or fingerprint sign-in (passkeys) and the assurance level check

| | |
| --- | --- |
| Status | Built (DS1, released `4912577`), **off**: passkeys are not turned on in Supabase Auth, so every passkey button stays hidden. QR sign-in works without it. |
| Who / where | Owner: Supabase → Authentication → passkeys (WebAuthn): **RP ID** `www.mytaviron.com` (host name only) and allowed origin `https://www.mytaviron.com`. A passkey belongs to one address: drivers who use `tltmaster.vercel.app` cannot use one made for `www`, and changing the address later means setting it up again. (The earlier note in docs/ACCOUNT_PROVISIONING.md §7 named `tltmaster.vercel.app`; superseded by the owner's decision of 2026-11-14.) |
| Variables | `PASSKEYS` (`off` hides passkeys even when Supabase offers them; unset = follow Supabase). |
| Assurance check (before any real driver) | Sign the test company's driver in with a passkey, then in the Supabase SQL editor: `select aal, created_at from auth.sessions where user_id = '<test driver id>' order by created_at desc limit 1;`. Expected `aal1`. **If it says `aal2`, stop** and tell Claude: a passkey must never count as two-step verification for money access (master plan DS1). The app already refuses passkeys to anyone with money access, but the database rule must hold for a direct Auth call too. |
| Verify | Test driver: QR code → My Day offers "Sign in with your face or fingerprint next time" → **Set it up** → sign out → **Sign in with face or fingerprint**. The office's driver page then shows "set up on 1 phone". |
| Off | `PASSKEYS` = `off`, redeploy (buttons hidden, passwords and QR codes keep working); then turn passkeys off in Supabase. Per driver: **Remove (lost or new phone)** on the driver's page. |

## 8. Public website, search engines and robots

| | |
| --- | --- |
| Status | Off (owner 2026-11-05: site behind the early-access gate; prices public at launch). |
| Before | The lawyer's terms and privacy (LR5), the legal entity name for the footer and legal pages, the owner's decision to publish. **Code change needed before indexing:** canonical addresses, the sitemap link in `robots.txt` and structured data use `PUBLIC_WEBSITE_URL` = `https://mytaviron.com` (`src/lib/site/urls.ts`), which now redirects to `www`; pick one address (recommended: `www`, the live one) so search engines are not sent to a redirect. |
| Who / where | Owner decides; owner sets the variables in Vercel. |
| Variables | `PUBLIC_SITE` (`on` opens the marketing pages and the lead form to everyone; the app stays behind the gate and sign-in); `SITE_INDEXING` (`on` lets search engines index the public pages only; read when the site is built, so it needs a redeploy). `EARLY_ACCESS_GATE` stays on. |
| Verify | `node scripts/check-deployment.mjs https://www.mytaviron.com` reports the public site open and everything else gated; https://www.mytaviron.com/robots.txt lists only the public pages (with `SITE_INDEXING=on`) or disallows everything (without); submit one lead from `/demo` and see it in Admin → Leads with the notification email. |
| Off | Delete `PUBLIC_SITE` and redeploy: the site goes back behind the gate. Indexing cannot be undone at once: with `SITE_INDEXING` removed, robots.txt disallows everything again, but search engines drop pages only over time. |

## 9. The address: custom domain and Supabase redirect URLs

| | |
| --- | --- |
| Status | `www.mytaviron.com` serves Production; `mytaviron.com` redirects to it; `tltmaster.vercel.app` stays as an extra address (owner 2026-11-14). |
| Who / where | Owner: Vercel (Settings → Domains, Environment Variables), Supabase (Authentication → URL Configuration), Intuit (redirect URI), UptimeRobot (monitor address). |
| Variables | `APP_BASE_URL` = `https://www.mytaviron.com` (email links, QR codes, QuickBooks redirect). |
| Checklist | Supabase Site URL `https://www.mytaviron.com`; Redirect URLs `https://www.mytaviron.com/auth/callback`, `/auth/confirm` and `/auth/confirm**`, keeping the `tltmaster.vercel.app` ones (docs/LAUNCH.md step 3). Intuit redirect URI on `www` (item 3). Passkey RP ID `www.mytaviron.com` (item 7). UptimeRobot watching `https://www.mytaviron.com/api/health`. |
| Verify | A password reset email's link opens `www.mytaviron.com`; a driver QR code opens `www.mytaviron.com/auth/qr`; `/api/health` answers ok on `www`. |
| Off | Set `APP_BASE_URL` back to `https://tltmaster.vercel.app` and redeploy; the Supabase entries for it are still there. |

## 10. Lock-screen notifications (web push)

| | |
| --- | --- |
| Status | **Not built** (docs/COMPANION_APP.md §7 item 2). Needs the owner's approval to build: a key pair as server-only variables (names chosen when it is built), one migration for device subscriptions, and a sender in Communications. iPhones show web push only for apps added to the home screen (iOS 16.4 or later). Lock-screen text would say only "New update in Taviron". |
| For January | Nothing to switch on unless the owner asks for it to be built first. |

## Record

| Service | Switched on (date) | By | Verified how | Notes |
| --- | --- | --- | --- | --- |
| App email | — | — | — | Planned before Dec 1 |
| Twilio texts | — | — | — | Registration to start in December |
| QuickBooks | — | — | — | Sandbox pending (owner) |
| AI | — | — | — | Evidence lapses about 2027-01-24 |
| HERE routing | — | — | — | Key status not recorded |
| GPS / ELD | — | — | — | Provider not chosen |
| Passkeys | — | — | — | Assurance check first |
| Public site / indexing | — | — | — | Canonical address fix first |
| Address (www) | 2026-11-14 decided | Owner | — | APP_BASE_URL and Supabase URLs: LAUNCH step 3 |
| Web push | — | — | — | Not built |

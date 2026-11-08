# Cold Call HQ — setup

## 1. Put the files in your site
- dashboard/index.html            -> arlomarketinggroup.com/dashboard
- netlify/functions/crm.mjs       -> GHL, Stripe, call log, Twilio token
- netlify/functions/voice.mjs     -> tells Twilio who to dial + which caller ID
- package.json                    -> merge "@netlify/blobs" into yours
- netlify.toml.snippet            -> paste into netlify.toml
Deploy with Git or `netlify deploy --prod` (drag-and-drop doesn't run functions).

## 2. GHL tokens (one per account)
Arlo GHL: Settings -> Private Integrations -> Create new integration. Turn on:
  contacts.readonly, contacts.write, conversations.readonly,
  conversations/message.readonly, conversations/message.write
Hula Creative: your brother does the same and sends you the token.
Location ID = the part after /v2/location/ in the GHL URL.

## 3. Twilio (calling right from the dashboard)
a) Sign up at twilio.com, then Upgrade (add ~$20). Trial accounts can only call verified numbers.
b) Show your GHL numbers as caller ID:
   Phone Numbers -> Manage -> Verified Caller IDs -> Add a new Caller ID.
   Enter your Arlo GHL number. Twilio calls it with a code. Answer in GHL and type the code.
   Do the same for the Hula number you want ContractFlow calls to show (your brother may need to answer).
c) API key: Account (top right) -> API keys & tokens -> Create API key (Standard).
   Save the SID (SK...) and the Secret. The secret only shows once.
d) TwiML App: Voice -> Manage -> TwiML apps -> Create.
   Voice Request URL: https://arlomarketinggroup.com/api/voice   (HTTP POST)
   Save the App SID (AP...).
e) Also copy your Account SID (AC...) and Auth Token from the Twilio console home page.

## 4. Netlify -> Site configuration -> Environment variables
DASHBOARD_PASSWORD     = (pick one)
GHL_ARLO_TOKEN         = pit-...
GHL_ARLO_LOCATION      = (Arlo location ID)
GHL_CF_TOKEN           = pit-...
GHL_CF_LOCATION        = (Hula location ID)
TWILIO_ACCOUNT_SID     = AC...
TWILIO_AUTH_TOKEN      = ...
TWILIO_API_KEY         = SK...
TWILIO_API_SECRET      = ...
TWILIO_APP_SID         = AP...
TWILIO_CALLERID_ARLO   = +1XXXXXXXXXX  (your verified Arlo GHL number)
TWILIO_CALLERID_CF     = +1XXXXXXXXXX  (verified Hula number)
STRIPE_KEY             = rk_live_...   (later)
Redeploy after adding them.

## 5. Daily use
- Tag leads cold-call in GHL. Pick Arlo or ContractFlow at the top.
- Hit Call (or the green phone button and type a number). It rings in the browser.
  First time, allow the microphone.
- Type email + notes, tap the outcome. The square fills, the tag lands in GHL,
  your GHL workflow sends the SMS from that account's number.
- Menu (three lines, top right) -> Conversations: texts and calls back to your GHL
  numbers, reply by text, or hit Call to call them back.

## 6. Automations
Tags added: cc-booked, cc-interested, cc-not-interested, cc-no-answer.
Trigger GHL workflows on "Contact Tag Added". Already use other tag names? Set
GHL_ARLO_TAGS / GHL_CF_TAGS, e.g. {"booked":"meeting booked","int":"interested","ni":"not interested","na":"no answer"}

## 7. Stripe (whenever)
Stripe -> Developers -> API keys -> Create restricted key, READ on Charges only.
Add as STRIPE_KEY. Revenue card + mountain peaks update every 5 minutes.

## Good to know
- Calls placed from the dashboard go through Twilio, so they show as a note on the
  contact in GHL (outcome, email, your notes), not as a call recording in GHL.
- Calls from verified caller IDs can get a lower carrier trust rating than a
  Twilio-bought number, so some phones may label them "Spam Likely" more often.
  If that happens a lot, buy a Twilio number and forward its calls to your GHL number.

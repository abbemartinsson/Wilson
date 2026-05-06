# 🚀 Fortnox + Slack Integration – Nästa steg (Implementation Plan)

Den här guiden visar exakt hur du går från din nuvarande setup (Slack + Railway backend) till en fungerande OAuth-integration med Fortnox.

---

# 🧱 Översikt av arkitektur

Du bygger detta flöde:

Slack UI → Railway Backend → Fortnox OAuth → Railway Callback → Supabase DB → Slack Notification

---

# 1. ⚙️ Förbered Railway (Environment Variables)

I Railway ska du lägga in:

## 🔐 Fortnox config

```
FORTNOX_CLIENT_ID=xxx
FORTNOX_CLIENT_SECRET=yyy
FORTNOX_REDIRECT_URL=https://din-app.up.railway.app/auth/fortnox/callback
```

## 🌍 App config

```
APP_BASE_URL=https://din-app.up.railway.app
```

## 💬 Slack config

```
SLACK_BOT_TOKEN=xxx
SLACK_SIGNING_SECRET=yyy
```

---

# 2. 🧭 Skapa backend endpoints

Du behöver två endpoints i din backend:

---

## 2.1 START endpoint

### Route:

```
GET /auth/fortnox/start
```

### Ansvar:

* Tar `slack_user_id` från query
* Bygger Fortnox OAuth URL
* Redirectar användaren till Fortnox login

### Logik:

* Spara `state = slack_user_id`
* Redirect till Fortnox authorization URL

---

## 2.2 CALLBACK endpoint

### Route:

```
GET /auth/fortnox/callback
```

### Ansvar:

* Tar emot `code` + `state`
* Byter code → access_token + refresh_token
* Sparar tokens i Supabase kopplat till Slack user
* Skickar Slack DM "Fortnox connected"

---

# 3. 🔐 Fortnox App setup

I Fortnox Developer Portal:

✔ Skapa app
✔ Få Client ID + Secret
✔ Sätt redirect URI:

```
https://din-app.up.railway.app/auth/fortnox/callback
```

---

# 4. 💬 Slack integration

## 4.1 Connect-knapp i Slack

När user skriver command eller klickar knapp:

➡️ Skicka dem till:

```
https://din-app.up.railway.app/auth/fortnox/start?slack_user_id=U123
```

---

## 4.2 Slack state mapping

Du använder:

```
state = slack_user_id
```

Så du vet vem som kopplade Fortnox.

---

## 4.3 Slack notification efter callback

När OAuth är klart:

➡️ Skicka DM via Slack API:

```
"Fortnox connected successfully ✅"
```

---

# 5. 🗄️ Databas (Supabase)

Tabell: `integrations`

```
id
slack_user_id
fortnox_access_token
fortnox_refresh_token
expires_at
updated_at
```

---

# 6. 🔄 OAuth flow (exakt sekvens)

```
1. Slack user clicks "Connect Fortnox"
2. /auth/fortnox/start
3. Redirect to Fortnox login
4. User approves
5. Fortnox redirects to /auth/fortnox/callback
6. Backend exchanges code → tokens
7. Tokens saved in Supabase
8. Slack DM sent
```

---

# 7. 🧠 Viktiga implementation decisions

## ✔ Du SKA göra:

* Store tokens per Slack user
* Use state parameter
* Handle callback securely
* Store refresh token

## ❌ Du ska INTE göra:

* Lagra tokens i frontend
* Hoppa över state
* Hårdkoda URLs

---

# 8. 🧪 Testplan (viktigt)

1. Test /start i browser
2. Verifiera Fortnox login
3. Kontrollera callback URL
4. Se tokens i Supabase
5. Test Slack DM

---

# 9. 🚀 Nästa steg efter detta

När detta fungerar:

* Koppla invoice fetching
* Bygg Slack commands
* Lägg till auto-refresh av tokens
* Bygg error recovery (reconnect flow)

---

# 💬 Sammanfattning

Du är nu i fasen där du:

✔ Skapar OAuth flow
✔ Kopplar Slack → backend
✔ Sparar tokens i DB

Detta är fundamentet för hela integrationen.

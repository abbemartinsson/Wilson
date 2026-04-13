# Backend – Datainsamling och prognossystem

Backend för att samla historisk projektdata från **Jira** och **Tempo** och lagra den i **Supabase**. Systemet möjliggör analys av tidigare projekt och prognoser för framtida projekt.

---

## Installation

```bash
npm install
```

Skapa `.env`-fil i `src/config/` genom att kopiera innehållet från
`src/config/envtemplate` och fylla i dina riktiga värden.

---

## Kommandon

### Slack AI-bot

Krav:
- Python 3 med beroenden installerade i `backend/python/requirements.txt`
- Node Reporting API startad (`npm run api`)

Starta API och bot:

```bash
npm run api
npm run bot
```

Boten tar emot DM i Slack, skickar meddelandet till Python chatbot-router, som anropar Node Reporting API samt Python forecast-pipeline och returnerar svaret till Slack.

---

### Synkronisering

Hämta data från Jira och Tempo och spara i databasen:

```bash
# Daglig synk (users + issues + worklogs)
npm run sync:daily

# Full synk (allt)
npm run sync:all

# Synka specifika tabeller
npm run sync:projects
npm run sync:users
npm run sync:issues
npm run sync:worklogs

# Uppdatera projekt-tidsstämplar (start_date, last_logged_issue)
npm run sync:timestamps
```

**OBS:** `start_date` och `last_logged_issue` uppdateras automatiskt efter worklog-sync i `sync:daily` och `sync:all`.

---

### Reporting och analys

#### 1. Sök efter projekt

Hitta projekt genom att söka på projektnamn eller project key (case-insensitive, fuzzy-matching).

**Kommando:**
```bash
npm run report:search-projects -- <sökord>
```

**Exempel:**
```bash
npm run report:search-projects -- hulta
npm run report:search-projects -- web
npm run report:search-projects -- ank
```

**Output:**
```json
[
  {
    "projectId": 3,
    "projectKey": "HULTP",
    "projectName": "Hultafors Project"
  },
  {
    "projectId": 8,
    "projectKey": "HULTA",
    "projectName": "Hultafors Internal Tools"
  }
]
```

Om inga projekt hittas:
```
No projects found matching your search.
```

---

#### 2. Hämta projektinfo

Få projektets tidsöversikt inklusive total tid, `start_date`, `last_logged_issue` och antal personer som loggat worklogs.

**Kommando:**
```bash
npm run report:get-project-info -- <PROJECT_KEY>
```

**Exempel:**
```bash
npm run report:get-project-info -- HULTP
npm run report:get-project-info -- ANK
```

**Output:**
```json
{
  "projectId": 3,
  "projectKey": "HULTP",
  "projectName": "Hultafors Project",
  "startDate": "2024-01-15T08:00:00.000Z",
  "lastLoggedIssue": "2026-03-09T09:30:00.000Z",
  "totalSeconds": 288000,
  "totalHours": 80.0,
  "contributorsCount": 7
}
```

Om projektet inte finns:
```
No project found for key: HULTP
```

---

#### 3. Arbetsbelastningsprognos (ML)

Generera ML-baserad prognos för framtida arbetsbelastning med Python-tränad modell.

**Kommando:**
```bash
npm run report:workload-forecast -- [MÅNADER]
```

**Exempel:**
```bash
npm run report:workload-forecast -- 3
npm run report:workload-forecast -- 6
```

**Output:**
- Månadsvisa prognoser med konfidensintervall
- Historisk jämförelse (samma period tidigare år)
- Nuvarande trender och statistik
- Antal aktiva användare per period

**Fördelar:**
- Visa om arbetsbelastning förväntas öka/minska
- Planera rekrytering baserat på prognoser
- Upptäck säsongsmönster i arbetsbelastning

---

#### 4. Historisk jämförelse

Jämför aktuell månad med samma månad tidigare år (year-over-year).

**Kommando:**
```bash
npm run report:historical -- [MÅNAD] [ÅR] [ANTAL_ÅR_TILLBAKA]
```

**Exempel:**
```bash
# Jämför nuvarande månad med tidigare år
npm run report:historical

# Jämför mars 2026 med tidigare 3 år
npm run report:historical -- 3 2026 3

# Jämför december 2025 med tidigare 2 år
npm run report:historical -- 12 2025 2
```

**Output:**
```json
{
  "current_period": {
    "year": 2026,
    "month": 3,
    "total_hours": 420.5,
    "active_users": 12,
    "worklog_count": 156
  },
  "previous_years": [
    {
      "year": 2025,
      "total_hours": 380.2,
      "active_users": 10,
      "compared_to_current": {
        "hours_difference": 40.3,
        "hours_change_percent": 10.6,
        "users_difference": 2
      }
    }
  ],
  "summary": {
    "trend": "increasing",
    "average_hours_across_years": 395.8
  }
}
```

**Användningsområden:**
- Identifiera tillväxt eller minskning över tid
- Se hur teamstorlek har förändrats
- Upptäck säsongsmönster år-över-år

---

#### 5. Arbetsbelastningsanalys

Få detaljerad analys av arbetsbelastning för en specifik period.

**Kommando:**
```bash
npm run report:analytics -- [ANTAL_MÅNADER_TILLBAKA]
```

**Exempel:**
```bash
# Analysera senaste 6 månaderna (default)
npm run report:analytics

# Analysera senaste 12 månaderna
npm run report:analytics -- 12
```

**Output:**
```json
{
  "summary": {
    "total_hours": 2450.5,
    "total_worklogs": 1240,
    "unique_users": 15,
    "average_weekly_hours": 95.2,
    "average_hours_per_user": 163.4
  },
  "weekly_breakdown": [...],
  "monthly_breakdown": [...]
}
```

---

## Python ML Setup

För att använda prognosfunktionerna behöver du installera Python-dependencies:

```bash
cd python
pip install -r requirements.txt
```

**Requirements:**
- Python 3.8+
- pandas, numpy, python-dateutil

Se [python/README.md](python/README.md) för mer information.

---

## Arbetsflöde

**Typiskt användningsscenario:**

1. **Synka data från Jira/Tempo:**
   ```bash
   npm run sync:all
   ```

2. **Hitta rätt projekt:**
   ```bash
   npm run report:search-projects -- hulta
   ```

3. **Hämta projektstatistik:**
   ```bash
  npm run report:get-project-info -- HULTP
   ```

---

## Struktur

```
src/
├── clients/          API-kommunikation (Jira, Tempo)
├── config/           Konfiguration och miljövariabler
├── repositories/     Databasinteraktion (Supabase)
├── services/         Affärslogik
├── forecasting/      Analys och prognoser
├── scripts/          Körbara scripts
├── slack-bot.js      Slack bot entrypoint
└── slackCommands.js  Kommandon för Slack-boten
```

---

## Framtida funktioner

- ✅ ML-baserade arbetsbelastningsprognoser
- ✅ Historiska jämförelser (year-over-year)
- ✅ Arbetsbelastningsanalys med trender
- Projektspecifika prognoser per project key
- Automatiska varningsmeddelanden vid överbelastning
- Slack-bot för att köra kommandon direkt i Slack
- Dashboard för visualisering av prognoser
- Avancerade ML-modeller (ARIMA, ensemble methods)
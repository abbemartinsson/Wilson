# Systemdokumentation – Datainsamling och prognossystem

## Syfte

Detta system samlar historisk projektdata från **Jira** och **Tempo** och lagrar den i en databas i **Supabase**. Syftet är att kunna analysera tidigare projekt och använda den informationen för att skapa prognoser för framtida projekt.

Systemet är i nuläget ett **internt verktyg** och fokuserar på analys på **projekt- och kundnivå**, inte individnivå.

Den insamlade datan ska senare kunna användas av en **Slack-bot** där användare kan ställa frågor om projektdata och få prognoser baserade på historiska projekt.

Exempel på frågor som systemet ska kunna besvara i framtiden:

* Hur många timmar har lagts på ett specifikt projekt?
* Hur lång tid tar liknande projekt i genomsnitt?
* Hur mycket arbete kan ett kommande projekt förväntas kräva?

---

# Systemöversikt

Systemet består av fyra huvuddelar:

1. Datainsamling från Jira
2. Datainsamling från Tempo
3. Lagring i Supabase
4. Analys och prognoser via Python
5. Interaktion via Slack

Översiktligt flöde:

```
Jira API
Tempo API
   │
   │ (daglig synkronisering)
   ↓

Datainsamlingsservice

   ↓

Supabase databas

   ↓

Python analys / prognoser

   ↓

Slack bot
```

---

# Datakällor

## Jira

Jira används för att hämta information om:

* Projekt
* Issues
* Användare
* Issue metadata

Viktiga fält från Jira:

| Fält             | Beskrivning                       |
| ---------------- | --------------------------------- |
| jira_project_id  | Unikt ID för projekt i Jira       |
| jira_project_key | Läsbar projektnyckel (ex: ABC)    |
| jira_issue_id    | Unikt ID för issue                |
| jira_issue_key   | Läsbar issue-nyckel (ex: ABC-123) |
| jira_account_id  | Unikt användar-ID                 |

---

## Tempo

Tempo används för att hämta **worklogs**, alltså registrerad arbetstid.

Viktiga fält:

| Fält               | Beskrivning          |
| ------------------ | -------------------- |
| time_spent_seconds | Loggad tid           |
| started_at         | När arbetet utfördes |

Worklogs kopplas alltid till ett **Jira issue**.

---

# Databas

Databasen ligger i Supabase och använder PostgreSQL.

Datamodellen är uppdelad i fyra huvudtabeller:

* projects
* users
* issues
* worklogs

Relationerna mellan tabellerna ser ut så här:

```
projects
   │
   └── issues
         │
         ├── assignee_user_id → users
         │
         └── worklogs
                └── user_id → users
```

---

# Tabeller

## projects

Representerar projekt från Jira.

| Kolumn           | Typ         | Beskrivning                                                    |
| ---------------- | ----------- | -------------------------------------------------------------- |
| id               | int8        | Internt databas-ID                                             |
| name             | text        | Projektnamn                                                    |
| start_date       | timestamptz | Första worklog för projektet (tidigaste started_at)            |
| jira_project_id  | int8        | Jira projekt-ID                                                |
| jira_project_key | text        | Jira projektnyckel                                             |
| created_at       | timestamptz | När posten skapades i databasen                                |
| updated_at       | timestamptz | När posten senast uppdaterades                                 |
| last_logged_issue| timestamptz | Senaste worklog för projektet (senaste started_at från någon issue) |

**Automatisk beräkning:**  
`start_date` och `last_logged_issue` beräknas automatiskt från worklogs vid sync.

---

## users

Representerar användare från Jira.

| Kolumn                 | Typ         |
| ---------------------- | ----------- |
| id                     | int8        |
| jira_account_id        | text        |
| name                   | text        |
| email                  | text        |
| capacity_hours_per_day | int8        |
| slack_account_id       | text        |
| slack_dm_channel_id    | text        |
| created_at             | timestamptz |
| updated_at             | timestamptz |

---

## issues

Representerar Jira-issues.

| Kolumn                 | Typ         |
| ---------------------- | ----------- |
| id                     | int8        |
| jira_issue_id          | int8        |
| jira_issue_key         | text        |
| project_id             | int8        |
| assignee_user_id       | int8        |
| title                  | text        |
| status                 | text        |
| estimated_time_seconds | int8        |
| created_at             | timestamptz |
| updated_at             | timestamptz |

---

## worklogs

Representerar arbetstid från Tempo.

| Kolumn             | Typ         |
| ------------------ | ----------- |
| id                 | int8        |
| issue_id           | int8        |
| user_id            | int8        |
| time_spent_seconds | int8        |
| started_at         | timestamptz |
| created_at         | timestamptz |
| updated_at         | timestamptz |

---

# Daglig synkronisering

Systemet ska köra en **daglig synkronisering** som hämtar data från Jira och Tempo och uppdaterar databasen.

Synkroniseringen ska ske i följande ordning:

```
1. Hämta projekt
2. Hämta användare
3. Hämta issues
4. Hämta worklogs
5. Uppdatera databasen
```

Det är viktigt att använda **upsert** när data skrivs till databasen för att undvika duplicerade rader.

---

# Steg för att hämta data till databasen

## 1. Hämta projekt från Jira

För varje projekt ska följande data sparas:

* jira_project_id
* jira_project_key
* name

Om projektet redan finns i databasen ska det uppdateras.

---

## 2. Hämta användare från Jira

För varje användare ska följande sparas:

* jira_account_id
* name
* email

Användare används senare för att koppla:

* issues
* worklogs

---

## 3. Hämta issues från Jira

För varje issue ska följande sparas:

* jira_issue_id
* jira_issue_key
* project_id
* assignee_user_id
* title
* status
* estimated_time_seconds

Issues kopplas till projekt via:

```
issues.project_id → projects.id
```

---

## 4. Hämta worklogs från Tempo

För varje worklog ska följande sparas:

* issue_id
* user_id
* time_spent_seconds
* started_at

Worklogs kopplas till:

```
worklogs.issue_id → issues.id
worklogs.user_id → users.id
```

---

# Analys och prognoser

När datan finns i databasen kan den användas för analys.

Exempel på analyser:

* total tid per projekt
* genomsnittlig tid per issue
* historisk arbetsbelastning
* uppskattad tidsåtgång för nya projekt

Analysen kommer att göras i **Python**.

Typiskt arbetsflöde:

```
1. Hämta data från Supabase
2. Konvertera till dataframe
3. Analysera historiska projekt
4. Beräkna prognoser
```

---

# Slack-integration

Användare kan interagera med systemet via Slack, främst i DM med boten.

I nuvarande implementation används textkommandon med `!`-prefix.

Exempel:

```
project info HULTP
!project search hulta
forecast 3
!history 3
```

Utöver kommandon kan boten även skicka vanliga frågor vidare till Python-router för AI-svar.

Flödet blir:

```
Slack DM / kommando
   ↓
Node backend (Slack bot)
   ↓
Python chatbot-router
   ↓
Node Reporting API + Python forecast-pipeline
   ↓
Svar till Slack
```

---

# Vidare utveckling

När grundsystemet fungerar kan följande utvecklas vidare:

* bättre prognosmodeller
* mer avancerad analys av projekt
* automatiska rapporter
* fler Slack-kommandon

Den viktigaste delen i första steget är att:

1. Samla korrekt historisk data
2. Lagra den strukturerat i databasen
3. Göra den tillgänglig för analys

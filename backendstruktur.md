# Backendstruktur – aktuell status

Det här dokumentet beskriver hur backend-repot ser ut just nu. Det är en inventering av den faktiska strukturen, inte ett förslag på en framtida struktur.

## Översikt

Repot är uppdelat i tre tydliga delar:

1. Node.js-backend i `backend/`
2. Python-del för AI/ML i `backend/python/`
3. Exempel och experiment i `ML/`

Backendens huvudflöde är:

```text
Jira API
Tempo API
   │
   ▼
Node.js API och Slack-bot
   │
   ├── clients/         -> anrop mot externa API:er
   ├── services/        -> affärslogik och orkestrering
   ├── repositories/    -> databasåtkomst mot Supabase
   ├── forecasting/     -> rapportering och prognoser
   └── scripts/         -> körbara CLI-script
```

## Roten av repot

I projektroten finns:

- `README.md` - kort projektbeskrivning
- `instructions.md` - arbetsinstruktioner
- `backendstruktur.md` - detta dokument
- `backend/` - själva backend-appen
- `ML/` - notebook-filer för experiment och test

## `backend/`

Det här är huvudappen.

### Filer på toppnivå

- `package.json` - scripts och beroenden
- `readme.md` - körinstruktioner och API-beskrivning
- `node_modules/` - installerade paket
- `python/` - Python-baserad prognosdel
- `src/` - Node.js-koden

## `backend/src/`

Det här är den viktigaste koden i projektet.

### Toppnivåfiler

- `index.js` - Express-server för reporting API
- `slack-bot.js` - Slack-bot som svarar på meddelanden och DMer
- `slackCommands.js` - textkommandon som `!help` och projektkommandon

### `src/config/`

Konfiguration och miljöhantering.

Filer:

- `envtemplate` - mall för miljövariabler
- `.env` - lokal miljöfil
- `index.js` - samlar konfigurationsvärden
- `jira.js` - Jira-konfiguration
- `supabase.js` - Supabase-konfiguration
- `tempo.js` - Tempo-konfiguration
- `README.md` - noteringar om konfigurationen

### `src/clients/`

HTTP-klienter mot externa tjänster.

Filer:

- `jiraClient.js` - anrop mot Jira
- `tempoClient.js` - anrop mot Tempo

### `src/services/`

Affärslogik och samordning mellan klienter och repositories.

Filer:

- `issueService.js` - logik för issues
- `projectService.js` - logik för projekt
- `pythonRouterService.js` - skickar data till Python-chatboten
- `syncService.js` - samordnar synkronisering
- `userService.js` - logik för användare
- `worklogService.js` - logik för worklogs

### `src/repositories/`

All databasåtkomst ligger här.

Filer:

- `analyticsRepository.js` - analytiska databasfrågor
- `issueRepository.js` - frågor för issues
- `projectRepository.js` - frågor för projekt
- `userRepository.js` - frågor för användare
- `worklogRepository.js` - frågor för worklogs

### `src/forecasting/`

Kod för rapporter, analys och prognoser.

Filer:

- `analyticsService.js` - analytiska sammanställningar
- `forecastSerive.js` - prognoslogik för arbetsbelastning
- `reportingService.js` - tjänster som används av API och Slack

### `src/scripts/`

Körbara script för manuella och schemalagda körningar.

Filer:

- `reporting.js` - CLI för rapporter
- `sendSlackTestMessage.js` - testar Slack-utskick
- `sync.js` - kör synkronisering av data

## `backend/python/`

Python-delen används för chatbot-flödet och ML-baserade prognoser.

Filer:

- `README.md` - beskrivning av Python-delen
- `requirements.txt` - Python-beroenden
- `supabase_chatbot.py` - Python-router/chatbot-flöde
- `workload_forecast.py` - prognosmodell för arbetsbelastning

## `ML/`

Här finns notebook-filer för tester och experiment.

Filer:

- `test_estimated_task.ipynb`
- `test_projecthours_prediction.ipynb`

## Nuvarande körbara delar

Det finns några centrala sätt att köra systemet på just nu:

- `npm run api` eller `npm start` - startar reporting API:t
- `npm run bot` - startar Slack-boten
- `npm run sync:daily` - kör daglig synk
- `npm run sync:all` - kör full synk
- `npm run report:workload` - kör prognosrapport
- `npm run report:historical` - kör historisk jämförelse

## Viktig notering

Det här repot innehåller inte längre en separat `tests/`, `jobs/`, `utils/` eller `slack/`-mapp i `backend/src/`. Slack-funktionerna ligger i stället direkt i `slack-bot.js` och `slackCommands.js`.

## Sammanfattning

Den aktuella strukturen är ganska rak:

- `clients` hämtar data
- `services` samordnar logiken
- `repositories` pratar med databasen
- `forecasting` och `python` hanterar analys och prognoser
- `scripts` ger CLI-stöd
- Slack-boten ligger direkt i `backend/src/`

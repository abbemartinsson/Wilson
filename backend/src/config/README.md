# Config

Denna mapp innehåller all konfiguration för systemet.

## Filer

- `.env` - Miljövariabler (kopiera från `envtemplate` och fyll i riktiga värden)
  Filen ligger under `src/config/.env`, vilket kräver att huvudskriptet
  laddar den med `dotenv.config({ path: './src/config/.env' })`.
- `envtemplate` - Mall för miljövariabler
- `jira.js` - Jira API-konfiguration
- `tempo.js` - Tempo API-konfiguration
- `supabase.js` - Supabase databas-konfiguration
- `index.js` - Exporterar alla konfigurationer

## Användning

```javascript
const config = require('./config');
console.log(config.jira.baseUrl);
```
# Plan: Togglebar tidsrapporteringspåminnelse i Slack

## Mål
Införa en inställning/kommando där användare kan välja om de vill få DM-påminnelse varje måndag och/eller fredag, samt få en sammanfattning av förra veckans rapporterade timmar.

Konfiguration ska ske i ett tydligt stegflöde i Slack:
1. Välj påminnelsedag: måndag, fredag, båda eller av.
2. Ange hur många timmar per vecka användaren jobbar.
3. Ingen manuell inmatning av "förra veckan". Systemet räknar ut detta automatiskt.
4. Alla beräkningar och utskick körs i samma tidszon: `Europe/Stockholm`.

Exempelmeddelande:
"You have reported 16/40 hours from the previous week, and three days have no time reported at all. Do you want to do that now?"

## 1. Definiera beteende och regler
1. Bestäm tillåtna lägen: `monday`, `friday`, `both`, `off`.
2. Bestäm veckomål per användare: `weekly_target_hours` (t.ex. 40, 37.5, 20).
3. Definiera "förra veckan" i fast tidszon `Europe/Stockholm` och beräkna den alltid automatiskt i systemet.
4. Definiera utskickstid, t.ex. `09:00` lokal tid.
5. Lås textformat för påminnelsemeddelandet.

## 2. Lägg till användarinställning i datamodellen
1. Lägg till fält för reminder i användarprofilen, t.ex.:
   - `timesheet_reminder_enabled` (bool)
   - `timesheet_reminder_day` (`monday|friday|both|off`)
   - `weekly_target_hours` (decimal/int, per användare)
   - valfritt: `timesheet_reminder_hour`
2. Sätt default till `off` för säker rollout.
3. Lägg till repository/service-metoder för read/update.
4. Checkpoint: verifiera att inställningen kan sparas/läsas utan regressions.

## 3. Lägg till Slack-kommando för toggle/status
1. Inför ett startkommando, t.ex. `!timesheet reminder setup`.
2. Efter kommandot kör botten ett guidat flöde:
   - Steg 1: "Välj dag" med valen måndag, fredag, båda, av.
   - Steg 2: "Hur många timmar jobbar du per vecka?" och spara värdet.
3. Lägg till `!timesheet reminder status` för att visa nuvarande inställning.
4. Lägg till `!timesheet reminder update` för att köra guiden igen.
5. Lägg till `!timesheet hours` för att visa:
   - loggade timmar denna vecka (måndag till idag)
   - loggade timmar denna månad (månadens första dag till idag)
6. Lägg till validering och felmeddelanden för ogiltig input (t.ex. negativa timmar).
7. Checkpoint: manuell test av setup, update, status och hours.

## 4. Bygg summeringslogik för föregående vecka
1. Skapa service-funktion, t.ex. `getPreviousWeekTimesheetSummary(userId)`.
2. Returnera minst:
   - `reportedHours`
   - `targetHours` (användarens `weekly_target_hours`)
   - `missingDaysCount`
   - `missingDays`
3. Beräkna från worklogs:
   - räkna ut förra veckans datumintervall automatiskt från systemdatum i `Europe/Stockholm`
   - filtrera på det datumintervallet
   - summera sekunder till timmar
   - gruppera per dag och räkna dagar med 0h
4. Checkpoint: enhetstester för 0/40, delvis (t.ex. 16/40), full (40/40).

## 4.1 Regel för "förra veckan" (ingen manuell input)
1. Definiera vecka som måndag till söndag i `Europe/Stockholm`.
2. Vid körning på måndag/fredag ska "förra veckan" alltid vara senaste kompletta måndag-söndag-intervall.
3. Exempel: om idag är fredag 2026-04-10 blir förra veckan 2026-03-30 till 2026-04-05.
4. Ingen användarfråga om datum behövs i setup-flödet.

## 4.2 Kommando för aktuell överblick (vecka/månad)
1. Skapa service-funktion, t.ex. `getCurrentPeriodHoursSummary(userId)`.
2. Returnera:
   - `weekHoursToDate` (måndag till nu)
   - `monthHoursToDate` (månadens start till nu)
   - valfritt: `weekTargetHours` för snabb jämförelse
3. Beräkna perioderna i `Europe/Stockholm` för konsekventa resultat.
4. Formatera Slack-svar, t.ex.:
   - "This week: 18.5h logged"
   - "This month: 62.0h logged"

## 5. Inför scheduler-jobb för utskick
1. Lägg till scheduler (t.ex. `node-cron`) som kör dagligen.
2. Vid körning:
   - hämta användare med reminder aktiv för dagens veckodag
   - beräkna summary per användare
   - skicka DM
3. Lägg idempotens för att undvika dubbelutskick samma dag:
   - `last_reminder_sent_at` eller separat reminder-logg.
4. Checkpoint: kör först i dry-run och verifiera logik.

## 6. Formatera meddelande och interaktion
1. Bygg meddelandet dynamiskt med summary-data.
2. Lägg gärna till actions:
   - `Open Tempo`
   - `Snooze 1 day`
   - `Turn off reminders`
3. Hantera fallback om användaren saknar lagrad DM-kanal.
4. Checkpoint: verifiera att DM går fram till testanvändare.

## 7. Loggning, felhantering och feature flag
1. Lägg strukturerad loggning:
   - antal användare matchade
   - antal skickade
   - antal fel
2. Lägg feature flag: `ENABLE_TIMESHEET_REMINDERS=false` initialt.
3. Lägg retry/rate-limit för Slack API-fel.
4. Se till att en användares fel inte stoppar hela batchen.

## 8. UAT och gradvis rollout
1. Starta med liten pilotgrupp.
2. Samla feedback på timing, frekvens och text.
3. Rulla ut gradvis till fler användare/team.
4. Ha rollback redo via feature flag.

## 9. Definition of Done
1. Användare kan toggla reminder via kommando.
2. Setup guidar användaren genom dagval och timmar/vecka.
3. DM skickas bara till rätt användare/rätt dag.
4. Meddelandet visar korrekt `X/targetHours` för förra veckan.
5. "Förra veckan" beräknas automatiskt av systemet.
6. Antal dagar utan rapporterad tid är korrekt.
7. Ingen dubbelnotis samma dag.
8. Kommandot `!timesheet hours` visar korrekt timmar för denna vecka och denna månad.
9. Alla tidsberäkningar använder `Europe/Stockholm`.
10. Tester finns: unit + minst ett end-to-end-flöde.

# MASTERPLAN – AI-assistent för resursplanering och projektinsikt
## Examensarbete

# 1. Projektöversikt
Detta examensarbete syftar till att utveckla en intern AI-assistent som kan analysera projektdata och tidrapportering för att ge prognoser kring resursbeläggning samt fungera som en chattbaserad assistent för att hämta information från flera system.

Systemet ska integrera data från:
- Jira
- SharePoint
- Git (valfritt)

och kunna användas via exempelvis Slack.

Målet är att skapa en fungerande prototyp som kan:
- Göra prognoser 1–4 veckor framåt  
- Visa arbetsbelastning och tillgänglighet  
- Svara på frågor om projekt och team  
- Fungera som intern AI-assistent  
- Eventuellt sätta upp (boka/boka om) möten  

---

# 2. Projektmål
Systemet ska kunna:

## Prognos och resursplanering
- Beräkna snittarbete senaste veckor  
- Uppskatta framtida arbetsbelastning  
- Visa vem som är tillgänglig  
- Ta hänsyn till semester och ledighet  
- Uppdateras med ny projektinformation  

## Intern AI-assistent
Man ska kunna fråga:
- Vad jobbar teamet med?  
- Status på projekt  
- Vem är mest belastad  
- Vem är ledig nästa vecka  
- Hur mycket tid läggs per projekt  

## Datakvalitet
Botten ska kunna fråga användare:
- Jobbar du fortfarande på projekt X?  
- Har du semester nästa vecka?  
- Startar projekt Y snart?  

---

# 3. Grundprincip: API vs Databas
Systemet ska använda både live-data och lagrad data.

## Hämta direkt från API (realtid)
När frågan gäller:
- idag  
- senaste ändringar  
- live status  

Exempel:
- Har vi möte idag?  
- Senaste commit?  
- Nyaste Jira-ticket?  
- Vad händer just nu?  

Då hämtas data direkt från API.

## Använd databas
När frågan gäller:
- historik  
- analys  
- prognos  
- statistik  
- framtid  

Exempel:
- Snitt senaste 4 veckor  
- Vem är ledig nästa vecka  
- Prognos framåt  
- Projektbelastning  

Då används lagrad data.

## Kombinera båda
Vanligast är att kombinera:
historik + ny information = prognos.

---

# 4. Databas (MVP)
En enkel databas behövs för:
- historik  
- prognoser  
- koppling mellan system  
- frånvaro  
- kapacitet  

## Förslag på tabeller
- users  
- projects  
- time_entries  
- absence  
- capacity  
- predictions  
- external_id_map  

ER-diagram skapas efter att funktioner och databehov är fastställda.

---

# 5. Uppdatering av databasen
Databasen behöver inte vara realtid.

Rekommenderat:
- Synkronisering: 1 gång per dag  
- Manuell sync-knapp vid behov  
- Live API endast vid realtidsfrågor  

Detta räcker för examensarbete och demonstration.

---

# 6. Prognoslogik
Systemet ska:
1. Hämta tid senaste 4 veckor  
2. Räkna snitt per person och projekt  
3. Ta hänsyn till:
   - semester  
   - nya projekt  
   - avslutade projekt  
4. Beräkna framtida belastning  
5. Visa tillgänglighet  

Exempel:
Kapacitet: 40h  
Snitt rapporade timmar per vecka: 32h  
Semester: 0h

(overhead buffert: 2-6h) idé
För att skapa mer realistiska prognoser kan systemet även inkludera en generell tidsbuffert för möten och interna uppgifter som inte alltid framgår av tidrapporteringen. Denna buffert dras från tillgänglig kapacitet vid beräkning av framtida arbetsbelastning.

Tillgänglig: 8h

Confidence kan visas som:
- Hög  
- Medium  
- Låg  

---

# 7. Chatfunktioner (Slack eller liknande)
Exempel på frågor:
- Vem är ledig nästa vecka?  
- Hur ser belastningen ut?  
- Kan vi starta nytt projekt?  
- Status på projekt X  
- Mest tid senaste veckor  
- Aktiva projekt  
- Är projekt X avslutat?  
- Har du semester?  
- Ska du jobba på projekt Y nästa vecka?

## Funktioner (tillägg)
- Frånvaro/sjukanmälnings chatt

---

# 8. Systemarkitektur
Slack eller annan chattplattform skickar frågor till backend.  
Backend hanterar logik, hämtar data från databasen och externa API:er.  
Resultat returneras till användaren via chatten.

---

# 9. Utmaningar
- Integration mellan flera API:er
- Datakvalitet och ofullständig data
- Koppling mellan användare i olika system
- Skapa realistiska prognoser
- Säkerhet kring intern data
- Avgränsning av funktioner

---

# 10. Teknisk stack   

---

# 11. Byggordning

## Steg 1 – Use cases ✔
- Visa tillgänglighet kommande veckor
- Visa belastning per person
- Ge enkel prognos framåt
- Visa projektstatus
- Svara på frågor om teamets arbete
- Hämta information från integrerade system
- Ta hänsyn till semester/ledighet
- Möjlighet att boka eller föreslå mötestider.

## Steg 2 – Databehov ✔

För att systemet ska kunna analysera arbetsbelastning, göra prognoser och fungera som en intern AI-assistent krävs följande data.

### Användare
- namn  
- unikt ID  
- koppling mellan system (Jira, SharePoint, Slack, Git)

Denna information krävs för att kunna koppla samma person mellan flera system och möjliggöra individbaserade frågor och analyser.

Källa:  
Jira, SharePoint, Slack och Git  

Data lagras även i intern databas för att möjliggöra koppling mellan systemen.

---

### Tidrapportering
- rapporterade timmar per person  
- projekt kopplade till arbetstid  
- datum och veckor  
- historik över tid  

Tidrapportering används för att analysera faktisk arbetstid, beräkna snittbelastning och skapa prognoser.

Källa:  
Jira / Tempo  

Data lagras i intern databas för analys och historik.

---

### Kapacitet
- arbetstid per vecka per person (heltid/deltid)

Kapacitet beskriver hur mycket en person normalt kan arbeta och används för att beräkna tillgänglighet och arbetsbelastning.

Källa:  
Jira/Tempo (om tillgängligt)  
Annars lagras kapacitet i intern databas.

---

### Frånvaro
- semester  
- ledighet  
- sjukfrånvaro  

Frånvaro används för att justera tillgänglig kapacitet och skapa mer tillförlitliga prognoser.

Källa:  
SharePoint och/eller kalender  

Lagring sker i intern databas för prognosberäkningar.

---

### Projekt
- aktiva projekt  
- start- och slutdatum  
- tilldelade personer  

Projektdata används för att förstå arbetsfördelning, resursbelastning och för att kunna svara på frågor om projektstatus.

Källa:  
Jira  

---

### Prognosdata
- snittarbete senaste veckor  
- beräknad framtida arbetsbelastning  
- uppskattad tillgänglig tid  

Denna data genereras av systemet baserat på historik, kapacitet och frånvaro och används för att stödja planering och beslutsfattande.

Källa:  
Beräknas och lagras i intern databas.

---

### Sammanfattning
Varje datatyp fyller en specifik funktion i systemet:

- Användardata kopplar samman system  
- Tidrapportering visar faktisk arbetstid  
- Kapacitet visar möjlig arbetstid  
- Frånvaro visar otillgänglighet  
- Projektdata visar arbetsfördelning  
- Prognosdata möjliggör framtidsanalys  

## Steg 3 – Databasmodell
Skapa ER-diagram.

## Steg 4 – Backend
Skapa API och databas.

## Steg 5 – Första integration
Exempel: Jira.

## Steg 6 – Chatbot
Koppla Slack eller annan chat.

## Steg 7 – Prognosfunktion
Implementera beräkningar.

## Steg 8 – Extra funktioner
AI-funktioner och förbättringar vid tid.

---

# 12. Förväntat resultat
En fungerande prototyp av en intern AI-assistent som:
- Integrerar flera system  
- Ger prognoser om resursbeläggning  
- Svarar på frågor via chat  
- Kan hjälpa till med mötesbokningar  
- Visar hur AI kan användas för intern planering och beslutsstöd  

Projektet ska visa:
- teknisk lösning  
- användbarhet  
- begränsningar  
- förbättringspotential  

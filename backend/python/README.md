# Python Machine Learning för Arbetsbelastningsprognoser

Detta system använder en Python-baserad ML-pipeline (NumPy + Pandas) för att träna en modell på historiska worklogs och prediktera timmar framåt.

## Installation

### 1. Installera Python 3.8+

Se till att du har Python installerat:
```bash
python --version
```

### 2. Installera Python-dependencies

```bash
cd backend/python
pip install -r requirements.txt
```

Eller med virtual environment (rekommenderat):
```bash
cd backend/python
python -m venv venv
source venv/bin/activate  # På Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Dependencies

- **pandas**: Datahantering och aggregering
- **numpy**: Numeriska beräkningar och modellträning
- **python-dateutil**: Datumhantering

## Hur det fungerar

### Input
Scriptet tar emot JSON-data via stdin:
```json
{
  "worklogs": [
    {
      "time_spent_seconds": 7200,
      "started_at": "2024-01-15T09:00:00Z",
      "user_id": 123
    }
  ],
  "forecast_months": 3,
  "include_historical": true
}
```

### Process
1. **Data preparation**: Konverterar worklogs till vecko- och månadsdata
2. **Model training**: Tränar en linjär regressionsmodell (ridge-liknande) i Python
3. **Forecasting**: Predikterar timmar för kommande månader (default 3)
4. **Historical comparison**: Jämför med samma period tidigare år

### Output
Scriptet returnerar JSON med:
- Månadsvisa aggregerade prognoser med intervall
- Historisk jämförelse (samma månad tidigare år)
- Nuvarande statistik och trender
- Datavalidering och kvalitetsmått

## Modellkonfiguration

Modellen tränas med:
- **Lag features**: senaste 4 månadernas utfall
- **Trend feature**: tidsindex för långsiktig förändring
- **Säsongsfeatures**: sinus/cosinus för 12-månadersmönster
- **Regularisering**: stabilare koefficienter via ridge-liknande lösning

## Användning från Node.js

Systemet anropas automatiskt från `forecastService.js`:

```javascript
const forecast = await forecastService.generateWorkloadForecast({
  forecastMonths: 3,
  includeHistorical: true
});
```

## Felsökning

### "Python not found"
- Kontrollera att Python är installerat och finns i PATH
- På Windows: Använd `python` eller `py` kommandot

### "Module not found"
- Installera dependencies: `pip install -r requirements.txt`
- Kontrollera virtual environment är aktiverat

### "Insufficient data for forecasting"
- Modellen kräver minst 8 månaders data för säkra prognoser
- Synkronisera mer historisk data från Jira/Tempo

### Import errors
- Vissa installationer kräver `python3` istället för `python`
- Uppdatera `forecastService.js` om annan Python-kommando behövs

## Prestandatips

- Första körningen tränar modellen direkt från historiska data
- Mer historisk data = bättre prognoser
- Minst 3-6 månaders historik rekommenderas

## Framtida förbättringar

- Support för fler modeller (ARIMA/Prophet/XGBoost)
- Automatisk modellval baserat på data
- Hyperparameter tuning
- Konfidensintervall-kalibrering
- Ensemble methods för robusthet

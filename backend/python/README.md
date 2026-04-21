# Python Machine Learning för Arbetsbelastningsprognoser

Detta system använder en notebook-baserad träningspipeline (scikit-learn) för att exportera en modell som sedan används av Slack-kommandot `!forecast`.

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
- **scikit-learn**: Modellträning (Ridge + RandomForest)
- **joblib**: Spara/ladda exporterad modell
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
2. **Model training (notebook)**: Tränar kandidatmodeller i `ML/workload_model_training.ipynb`
3. **Model export**: Sparar bästa modell till `backend/python/models/workload_forecast_model.joblib`
4. **Forecasting runtime**: `backend/python/workload_forecast.py` laddar den exporterade modellen
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
- **Kandidatmodeller**: Ridge och RandomForest
- **Modellval**: lägst RMSE på tidsserie-validering

## Träna och exportera modell

1. Öppna `ML/workload_model_training.ipynb`
2. Kör cellerna i ordning
3. Bekräfta att modellen sparas till:

```text
backend/python/models/workload_forecast_model.joblib
```

Valfritt: sätt en egen sökväg med env-var:

```bash
WORKLOAD_FORECAST_MODEL_PATH=/abs/path/to/workload_forecast_model.joblib
```

## Användning från Node.js

Systemet anropas automatiskt från `src/forecasting/forecastSerive.js`
och via Python-routern i `src/services/pythonRouterService.js`.

Exempel (från forecasting-modulen):

```javascript
const forecastService = require('./src/forecasting/forecastSerive');

const report = await forecastService.getComprehensiveWorkloadForecast({
  forecastMonths: 3,
});
```

## Felsökning

### "Python not found"
- Kontrollera att Python är installerat och finns i PATH
- På Windows: Använd `python` eller `py` kommandot

### "Module not found"
- Installera dependencies: `pip install -r requirements.txt`
- Kontrollera virtual environment är aktiverat

### "Model artifact not found"
- Träna/exportera modellen i `ML/workload_model_training.ipynb`
- Kontrollera att filen finns i `backend/python/models/workload_forecast_model.joblib`
- Eller sätt `WORKLOAD_FORECAST_MODEL_PATH` till rätt fil

### "Insufficient data for forecasting"
- Modellen kräver minst 8 månaders data för säkra prognoser
- Synkronisera mer historisk data från Jira/Tempo

### Import errors
- Vissa installationer kräver `python3` istället för `python`
- Sätt `PYTHON_EXECUTABLE` i miljön om annat Python-kommando/binär behövs

## Prestandatips

- Träna om modellen manuellt när datamönster ändras
- Mer historisk data = bättre prognoser
- Minst 6-12 månaders historik rekommenderas

## Framtida förbättringar

- Support för fler modeller (ARIMA/Prophet/XGBoost)
- Automatisk modellval baserat på data
- Hyperparameter tuning
- Konfidensintervall-kalibrering
- Ensemble methods för robusthet

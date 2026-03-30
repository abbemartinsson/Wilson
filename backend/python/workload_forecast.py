#!/usr/bin/env python3
"""
Workload forecasting using Prophet for time series prediction.
Reads historical worklog data from stdin and outputs forecast to stdout.
"""
import sys
import json
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from prophet import Prophet
import warnings

warnings.filterwarnings('ignore')


def prepare_data(worklogs):
    """
    Convert worklog data to Prophet format (ds, y).
    Group by week and calculate total hours worked.
    """
    if not worklogs:
        raise ValueError("No worklog data provided")
    
    df = pd.DataFrame(worklogs)
    
    # Convert started_at to datetime
    df['started_at'] = pd.to_datetime(df['started_at'])
    
    # Ignore future worklogs to avoid training on planned/incorrect future dates.
    now = pd.Timestamp.now(tz=df['started_at'].dt.tz)
    df = df[df['started_at'] <= now]

    if df.empty:
        raise ValueError("No historical worklogs available (all records are in the future)")

    # Convert seconds to hours
    df['hours'] = df['time_spent_seconds'] / 3600.0
    
    # Group by week
    df['week_start'] = df['started_at'].dt.to_period('W').dt.start_time
    
    # Aggregate by week
    weekly_data = df.groupby('week_start').agg({
        'hours': 'sum',
        'user_id': 'nunique'  # Count unique users per week
    }).reset_index()
    
    weekly_data.columns = ['ds', 'y', 'active_users']
    
    return weekly_data


def train_and_forecast(df, periods_months=3):
    """
    Train Prophet model and generate forecast.
    
    Args:
        df: DataFrame with columns [ds, y, active_users]
        periods_months: Number of months to forecast
    
    Returns:
        dict with forecast data
    """
    # Configure Prophet model
    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=False,
        daily_seasonality=False,
        changepoint_prior_scale=0.05,  # Lower = less flexible, more stable
        seasonality_prior_scale=10.0
    )
    
    # Fit model
    model.fit(df[['ds', 'y']])
    
    now = datetime.now()
    next_month_start = datetime(now.year, now.month, 1) + pd.DateOffset(months=1)
    next_month_start = pd.Timestamp(next_month_start).to_pydatetime()
    horizon_end = (pd.Timestamp(next_month_start) + pd.DateOffset(months=periods_months) - pd.Timedelta(days=1)).to_pydatetime()

    # Forecast enough weekly points to cover the full month horizon.
    last_training_date = pd.to_datetime(df['ds']).max().to_pydatetime()
    days_to_cover = (horizon_end - last_training_date).days
    weeks_to_forecast = max(1, int(np.ceil(days_to_cover / 7.0)) + 2)
    
    # Create future dataframe
    future = model.make_future_dataframe(periods=weeks_to_forecast, freq='W-MON')
    
    # Generate forecast
    forecast = model.predict(future)
    
    # Extract relevant columns
    full_weekly = forecast[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].tail(weeks_to_forecast).copy()

    # Keep only points from the forecast period and expand weekly values over days
    # so monthly totals align with calendar month boundaries.
    forecast_result = full_weekly[full_weekly['ds'] > pd.to_datetime(last_training_date)].copy()

    daily_rows = []
    for _, row in forecast_result.iterrows():
        week_start = pd.to_datetime(row['ds'])
        for offset in range(7):
            day = week_start + pd.Timedelta(days=offset)
            if pd.Timestamp(next_month_start) <= day <= pd.Timestamp(horizon_end):
                daily_rows.append({
                    'date': day,
                    'yhat': row['yhat'] / 7.0,
                    'yhat_lower': row['yhat_lower'] / 7.0,
                    'yhat_upper': row['yhat_upper'] / 7.0
                })

    if daily_rows:
        daily_df = pd.DataFrame(daily_rows)
        daily_df['month'] = daily_df['date'].dt.to_period('M')
        monthly_forecast = daily_df.groupby('month').agg({
            'yhat': 'sum',
            'yhat_lower': 'sum',
            'yhat_upper': 'sum'
        }).reset_index()
    else:
        monthly_forecast = pd.DataFrame(columns=['month', 'yhat', 'yhat_lower', 'yhat_upper'])

    monthly_forecast['month'] = monthly_forecast['month'].astype(str)
    monthly_forecast.columns = ['month', 'predicted_hours', 'lower_bound', 'upper_bound']
    
    return {
        'weekly_forecast': forecast_result[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].to_dict('records'),
        'monthly_forecast': monthly_forecast.to_dict('records'),
        'model_stats': {
            'training_samples': len(df),
            'forecast_weeks': weeks_to_forecast,
            'forecast_months': periods_months
        }
    }


def calculate_historical_comparison(df, current_date=None):
    """
    Calculate historical workload for same period in previous years.
    
    Args:
        df: DataFrame with columns [ds, y, active_users]
        current_date: Reference date (default: today)
    
    Returns:
        dict with historical comparison data
    """
    if current_date is None:
        current_date = datetime.now()
    
    # Get current month and day
    current_month = current_date.month
    current_day = current_date.day
    
    comparisons = []
    
    # Look back up to 3 years
    for years_back in range(1, 4):
        comparison_year = current_date.year - years_back
        
        # Calculate date range (current month ± 2 weeks)
        year_start = datetime(comparison_year, current_month, 1)
        
        # Find last day of month
        if current_month == 12:
            year_end = datetime(comparison_year + 1, 1, 1) - timedelta(days=1)
        else:
            year_end = datetime(comparison_year, current_month + 1, 1) - timedelta(days=1)
        
        # Filter data for this period
        period_data = df[(df['ds'] >= year_start) & (df['ds'] <= year_end)]
        
        if len(period_data) > 0:
            total_hours = period_data['y'].sum()
            avg_weekly_hours = period_data['y'].mean()
            max_users = period_data['active_users'].max()
            avg_users = period_data['active_users'].mean()
            
            comparisons.append({
                'year': comparison_year,
                'period': f"{year_start.strftime('%Y-%m-%d')} to {year_end.strftime('%Y-%m-%d')}",
                'total_hours': round(total_hours, 2),
                'average_weekly_hours': round(avg_weekly_hours, 2),
                'max_active_users': int(max_users),
                'average_active_users': round(avg_users, 2),
                'weeks_with_data': len(period_data)
            })
    
    return comparisons


def main():
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        
        worklogs = input_data.get('worklogs', [])
        forecast_months = input_data.get('forecast_months', 3)
        include_historical = input_data.get('include_historical', True)
        
        if not worklogs:
            raise ValueError("No worklog data provided")
        
        # Prepare data
        df = prepare_data(worklogs)
        
        if len(df) < 8:
            raise ValueError(f"Insufficient data for forecasting. Need at least 8 weeks, got {len(df)}")
        
        # Generate forecast
        forecast_result = train_and_forecast(df, forecast_months)
        
        # Calculate historical comparison
        historical_comparison = []
        if include_historical:
            historical_comparison = calculate_historical_comparison(df)
        
        # Calculate current stats
        last_4_weeks = df.tail(4)
        current_stats = {
            'last_4_weeks_hours': round(last_4_weeks['y'].sum(), 2),
            'last_4_weeks_avg': round(last_4_weeks['y'].mean(), 2),
            'current_active_users': int(last_4_weeks['active_users'].iloc[-1]) if len(last_4_weeks) > 0 else 0,
            'trend': 'increasing' if last_4_weeks['y'].iloc[-1] > last_4_weeks['y'].mean() else 'decreasing'
        }
        
        # Prepare output
        output = {
            'success': True,
            'forecast': forecast_result,
            'historical_comparison': historical_comparison,
            'current_stats': current_stats,
            'data_range': {
                'start_date': df['ds'].min().strftime('%Y-%m-%d'),
                'end_date': df['ds'].max().strftime('%Y-%m-%d'),
                'total_weeks': len(df)
            }
        }
        
        # Output as JSON
        print(json.dumps(output, indent=2, default=str))
        sys.exit(0)
        
    except Exception as e:
        error_output = {
            'success': False,
            'error': str(e),
            'error_type': type(e).__name__
        }
        print(json.dumps(error_output, indent=2))
        sys.exit(1)


if __name__ == '__main__':
    main()

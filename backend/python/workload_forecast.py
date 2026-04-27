#!/usr/bin/env python3
"""Workload forecasting runtime for Slack command integration."""

import json
import sys
import warnings
from datetime import datetime, timedelta

import pandas as pd

from workload_model import (
    aggregate_monthly,
    forecast_with_artifact,
    load_model_artifact,
    prepare_weekly_data,
    resolve_model_path,
    save_model_artifact,
    train_best_model,
)

warnings.filterwarnings("ignore")


def forecast_from_exported_model(weekly_df, periods_months=3):
    """Run forecasting using a pre-trained model artifact exported from notebook."""
    monthly_df = aggregate_monthly(weekly_df)
    if len(monthly_df) < 4:
        raise ValueError(f"Insufficient monthly data for forecasting. Need at least 4 months, got {len(monthly_df)}")

    model_path = resolve_model_path()
    try:
        artifact = load_model_artifact(model_path)
    except FileNotFoundError:
        # Fall back to runtime training when a notebook-exported artifact is unavailable.
        artifact = train_best_model(monthly_df)
        try:
            save_model_artifact(artifact, model_path)
        except Exception:
            # Forecast should still work even if persisting the artifact fails.
            pass

    monthly_forecast = forecast_with_artifact(monthly_df, artifact, periods_months=periods_months)

    return {
        "weekly_forecast": [],
        "monthly_forecast": monthly_forecast,
        "model_stats": {
            "training_samples_weeks": len(weekly_df),
            "training_samples_months": len(monthly_df),
            "forecast_months": periods_months,
            "model": artifact.get("model_name", "Unknown"),
            "features": artifact.get("feature_columns", []),
            "model_trained_at": artifact.get("trained_at"),
            "model_path": str(model_path),
        },
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
        df = prepare_weekly_data(worklogs)
        
        if len(df) < 8:
            raise ValueError(f"Insufficient data for forecasting. Need at least 8 weeks, got {len(df)}")
        
        # Use pre-trained exported model from notebook
        forecast_result = forecast_from_exported_model(df, forecast_months)
        
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
        guidance = (
            " Ensure model artifact exists (default: backend/python/models/workload_forecast_model.joblib)."
            " Train/export it from ML/workload_model_training.ipynb."
        )

        error_output = {
            'success': False,
            'error': f"{str(e)}{guidance}",
            'error_type': type(e).__name__
        }
        print(json.dumps(error_output, indent=2))
        sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Workload forecasting using a Python ML model.
Reads historical worklog data from stdin and outputs forecast to stdout.
"""
import sys
import json
import warnings
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")


def prepare_weekly_data(worklogs):
    """
    Convert raw worklogs to weekly aggregates.
    """
    if not worklogs:
        raise ValueError("No worklog data provided")

    df = pd.DataFrame(worklogs)
    df["started_at"] = pd.to_datetime(df["started_at"], utc=True, errors="coerce")
    df = df.dropna(subset=["started_at", "time_spent_seconds"])

    if df.empty:
        raise ValueError("No valid worklog rows after parsing timestamps")

    now = pd.Timestamp.utcnow()
    df = df[df["started_at"] <= now]

    if df.empty:
        raise ValueError("No historical worklogs available (all rows are future-dated)")

    df["hours"] = pd.to_numeric(df["time_spent_seconds"], errors="coerce").fillna(0.0) / 3600.0
    df["week_start"] = df["started_at"].dt.to_period("W-MON").dt.start_time

    weekly = (
        df.groupby("week_start")
        .agg(hours=("hours", "sum"), active_users=("user_id", "nunique"))
        .reset_index()
        .rename(columns={"week_start": "ds", "hours": "y"})
    )

    weekly["ds"] = pd.to_datetime(weekly["ds"]).dt.tz_localize(None)
    weekly = weekly.sort_values("ds").reset_index(drop=True)
    return weekly


def build_training_matrix(series):
    """
    Build lag/time features for supervised learning.
    """
    values = list(series)
    rows = []
    for i in range(4, len(values)):
        month_index = i + 1
        month_of_year = ((month_index - 1) % 12) + 1
        rows.append(
            {
                "lag1": values[i - 1],
                "lag2": values[i - 2],
                "lag3": values[i - 3],
                "lag4": values[i - 4],
                "trend": month_index,
                "sin12": np.sin(2 * np.pi * month_of_year / 12.0),
                "cos12": np.cos(2 * np.pi * month_of_year / 12.0),
                "target": values[i],
            }
        )

    if not rows:
        raise ValueError("Not enough monthly samples for model training")

    train_df = pd.DataFrame(rows)
    feature_cols = ["lag1", "lag2", "lag3", "lag4", "trend", "sin12", "cos12"]
    return train_df[feature_cols], train_df["target"], feature_cols


def fit_linear_model(x_train, y_train, alpha=1e-3):
    """
    Fit a regularized linear model using the closed-form ridge solution.
    """
    x = x_train.to_numpy(dtype=float)
    y = y_train.to_numpy(dtype=float)
    ones = np.ones((x.shape[0], 1), dtype=float)
    x_aug = np.concatenate([ones, x], axis=1)

    identity = np.eye(x_aug.shape[1], dtype=float)
    identity[0, 0] = 0.0  # do not regularize intercept

    weights = np.linalg.pinv(x_aug.T @ x_aug + alpha * identity) @ x_aug.T @ y

    def predict_fn(features_df):
        fx = features_df.to_numpy(dtype=float)
        fones = np.ones((fx.shape[0], 1), dtype=float)
        fx_aug = np.concatenate([fones, fx], axis=1)
        return fx_aug @ weights

    return predict_fn


def aggregate_monthly(weekly_df):
    monthly = weekly_df.copy()
    monthly["month"] = monthly["ds"].dt.to_period("M")
    grouped = monthly.groupby("month", as_index=False).agg(y=("y", "sum"), active_users=("active_users", "mean"))
    grouped["month"] = grouped["month"].astype(str)
    return grouped


def train_and_forecast_months(weekly_df, periods_months=3):
    """
    Train a RandomForest model on monthly workload and forecast future months.
    """
    monthly_df = aggregate_monthly(weekly_df)
    if len(monthly_df) < 8:
        raise ValueError(f"Insufficient monthly data for forecasting. Need at least 8 months, got {len(monthly_df)}")

    monthly_values = monthly_df["y"].astype(float).tolist()
    x_train, y_train, feature_cols = build_training_matrix(monthly_values)

    predict_fn = fit_linear_model(x_train, y_train)

    residuals = y_train.values - predict_fn(x_train)
    residual_std = float(np.std(residuals)) if len(residuals) > 1 else 0.0
    interval_width = max(5.0, 1.96 * residual_std)

    now = datetime.now()
    first_month = pd.Timestamp(datetime(now.year, now.month, 1)) + pd.DateOffset(months=1)

    rolling = monthly_values[-4:]
    monthly_forecast = []
    for step in range(1, periods_months + 1):
        forecast_month_ts = first_month + pd.DateOffset(months=step - 1)
        month_index = len(monthly_values) + step
        month_of_year = ((month_index - 1) % 12) + 1

        feature_row = {
            "lag1": rolling[-1],
            "lag2": rolling[-2],
            "lag3": rolling[-3],
            "lag4": rolling[-4],
            "trend": month_index,
            "sin12": np.sin(2 * np.pi * month_of_year / 12.0),
            "cos12": np.cos(2 * np.pi * month_of_year / 12.0),
        }
        x_future = pd.DataFrame([feature_row])[feature_cols]
        prediction = float(predict_fn(x_future)[0])
        prediction = max(0.0, prediction)

        lower = max(0.0, prediction - interval_width)
        upper = prediction + interval_width

        monthly_forecast.append(
            {
                "month": forecast_month_ts.strftime("%Y-%m"),
                "predicted_hours": round(prediction, 2),
                "lower_bound": round(lower, 2),
                "upper_bound": round(upper, 2),
            }
        )

        rolling.append(prediction)
        rolling = rolling[-4:]

    return {
        "weekly_forecast": [],
        "monthly_forecast": monthly_forecast,
        "model_stats": {
            "training_samples_weeks": len(weekly_df),
            "training_samples_months": len(monthly_df),
            "forecast_months": periods_months,
            "model": "RidgeLinearRegression",
            "features": feature_cols,
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
        df = prepare_weekly_data(worklogs)
        
        if len(df) < 8:
            raise ValueError(f"Insufficient data for forecasting. Need at least 8 weeks, got {len(df)}")
        
        # Train model and forecast coming months
        forecast_result = train_and_forecast_months(df, forecast_months)
        
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

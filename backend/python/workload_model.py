#!/usr/bin/env python3
"""Shared utilities for training and running the workload forecast model."""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.ensemble import (
    ExtraTreesRegressor,
    GradientBoostingRegressor,
    HistGradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.linear_model import ElasticNet, HuberRegressor, Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error


DEFAULT_MODEL_FILENAME = "workload_forecast_model.joblib"
DEFAULT_LAG_COUNT = 4


def get_default_model_path() -> Path:
    return Path(__file__).resolve().parent / "models" / DEFAULT_MODEL_FILENAME


def resolve_model_path(explicit_path: str | None = None) -> Path:
    model_path = explicit_path or os.getenv("WORKLOAD_FORECAST_MODEL_PATH")
    if model_path:
        return Path(model_path).expanduser().resolve()
    return get_default_model_path()


def prepare_weekly_data(worklogs):
    """Convert raw worklogs to weekly aggregates."""
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


def aggregate_monthly(weekly_df):
    monthly = weekly_df.copy()
    monthly["month_period"] = monthly["ds"].dt.to_period("M")
    grouped = monthly.groupby("month_period", as_index=False).agg(y=("y", "sum"), active_users=("active_users", "mean"))

    # Drop the currently ongoing month to avoid training on partial totals.
    current_month = pd.Timestamp.utcnow().to_period("M")
    if not grouped.empty and grouped["month_period"].iloc[-1] == current_month:
        grouped = grouped.iloc[:-1].copy()

    grouped["month"] = grouped["month_period"].astype(str)
    return grouped


def build_training_matrix(monthly_values, lags=DEFAULT_LAG_COUNT):
    rows = []
    for i in range(lags, len(monthly_values)):
        month_index = i + 1
        month_of_year = ((month_index - 1) % 12) + 1
        rolling = monthly_values[(i - lags):i]

        row = {
            "trend": month_index,
            "sin12": np.sin(2 * np.pi * month_of_year / 12.0),
            "cos12": np.cos(2 * np.pi * month_of_year / 12.0),
            "lag_mean_2": float(np.mean(rolling[-2:])),
            "lag_mean_4": float(np.mean(rolling[-4:])),
            "lag_std_4": float(np.std(rolling[-4:])),
            "lag_diff_1": float(rolling[-1] - rolling[-2]),
            "target": monthly_values[i],
        }

        for lag in range(1, lags + 1):
            row[f"lag{lag}"] = monthly_values[i - lag]

        rows.append(row)

    if not rows:
        raise ValueError(f"Not enough monthly samples for model training. Need at least {lags + 1} months.")

    train_df = pd.DataFrame(rows)
    lag_cols = [f"lag{lag}" for lag in range(1, lags + 1)]
    extra_cols = ["lag_mean_2", "lag_mean_4", "lag_std_4", "lag_diff_1"]
    feature_cols = lag_cols + extra_cols + ["trend", "sin12", "cos12"]
    return train_df[feature_cols], train_df["target"], feature_cols


def _walk_forward_metrics(x_data, y_data, model, min_train_size=6):
    if len(x_data) < (min_train_size + 1):
        raise ValueError(
            f"Need at least {min_train_size + 1} feature rows for walk-forward validation, got {len(x_data)}"
        )

    predictions = []
    actuals = []

    for split_idx in range(min_train_size, len(x_data)):
        x_train = x_data.iloc[:split_idx]
        y_train = y_data.iloc[:split_idx]
        x_test = x_data.iloc[split_idx:split_idx + 1]
        y_test = y_data.iloc[split_idx:split_idx + 1]

        fold_model = clone(model)
        fold_model.fit(x_train, y_train)
        y_pred = fold_model.predict(x_test)[0]

        predictions.append(float(y_pred))
        actuals.append(float(y_test.iloc[0]))

    y_true = np.array(actuals, dtype=float)
    y_hat = np.array(predictions, dtype=float)

    mae = float(mean_absolute_error(y_true, y_hat))
    rmse = float(np.sqrt(mean_squared_error(y_true, y_hat)))
    residuals = y_true - y_hat
    residual_std = float(np.std(residuals)) if len(residuals) > 1 else 0.0

    denominator = np.where(np.abs(y_true) < 1e-9, 1.0, np.abs(y_true))
    mape = float(np.mean(np.abs((y_true - y_hat) / denominator)) * 100)

    return {
        "mae": mae,
        "rmse": rmse,
        "mape": mape,
        "residual_std": residual_std,
        "folds": len(y_true),
    }


def _candidate_models(random_state=42):
    return [
        ("Ridge_a0.1", Ridge(alpha=0.1)),
        ("Ridge_a1", Ridge(alpha=1.0)),
        ("Ridge_a10", Ridge(alpha=10.0)),
        ("ElasticNet_a0.01_l1_0.2", ElasticNet(alpha=0.01, l1_ratio=0.2, random_state=random_state, max_iter=10000)),
        ("ElasticNet_a0.05_l1_0.5", ElasticNet(alpha=0.05, l1_ratio=0.5, random_state=random_state, max_iter=10000)),
        ("Huber", HuberRegressor(epsilon=1.35, alpha=0.0001, max_iter=1000)),
        ("RandomForest_d3", RandomForestRegressor(n_estimators=500, max_depth=3, random_state=random_state)),
        ("RandomForest_d5", RandomForestRegressor(n_estimators=500, max_depth=5, random_state=random_state)),
        ("ExtraTrees_d3", ExtraTreesRegressor(n_estimators=500, max_depth=3, random_state=random_state)),
        ("ExtraTrees_d5", ExtraTreesRegressor(n_estimators=500, max_depth=5, random_state=random_state)),
        ("GradientBoosting", GradientBoostingRegressor(random_state=random_state)),
        ("HistGradientBoosting", HistGradientBoostingRegressor(random_state=random_state)),
    ]


def train_best_model(monthly_df, random_state=42):
    if len(monthly_df) < DEFAULT_LAG_COUNT + 2:
        raise ValueError(
            f"Insufficient monthly data for training. Need at least {DEFAULT_LAG_COUNT + 2} months, got {len(monthly_df)}"
        )

    monthly_values = monthly_df["y"].astype(float).tolist()
    x_data, y_data, feature_cols = build_training_matrix(monthly_values, lags=DEFAULT_LAG_COUNT)

    candidate_results = []
    best_name = None
    best_model = None
    best_rmse = float("inf")
    best_mae = float("inf")
    best_residual_std = 0.0

    min_train_size = max(6, len(x_data) // 2)
    min_train_size = min(min_train_size, len(x_data) - 1)

    for name, model in _candidate_models(random_state=random_state):
        try:
            metrics = _walk_forward_metrics(x_data, y_data, model, min_train_size=min_train_size)
            rmse = float(metrics["rmse"])
            mae = float(metrics["mae"])

            candidate_results.append(
                {
                    "model": name,
                    "mae": round(mae, 4),
                    "rmse": round(rmse, 4),
                    "mape": round(float(metrics["mape"]), 4),
                    "folds": int(metrics["folds"]),
                }
            )

            is_better = (rmse < best_rmse) or (np.isclose(rmse, best_rmse) and mae < best_mae)
            if is_better:
                best_rmse = rmse
                best_mae = mae
                best_name = name
                best_model = clone(model)
                best_residual_std = float(metrics["residual_std"])
        except Exception as model_error:
            candidate_results.append(
                {
                    "model": name,
                    "mae": None,
                    "rmse": None,
                    "mape": None,
                    "folds": 0,
                    "error": str(model_error),
                }
            )

    if best_model is None:
        raise ValueError("No candidate model could be trained successfully.")

    best_model.fit(x_data, y_data)

    artifact = {
        "model": best_model,
        "model_name": best_name,
        "feature_columns": feature_cols,
        "lags": DEFAULT_LAG_COUNT,
        "residual_std": best_residual_std,
        "trained_at": datetime.utcnow().isoformat(),
        "training_samples_months": len(monthly_df),
        "training_samples_rows": len(x_data),
        "validation_type": "walk_forward",
        "validation_min_train_size": min_train_size,
        "candidates": candidate_results,
    }
    return artifact


def save_model_artifact(artifact, model_path: Path):
    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, model_path)


def load_model_artifact(model_path: Path):
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model artifact not found at {model_path}. Train and export the model from notebook first."
        )

    artifact = joblib.load(model_path)
    required_keys = ["model", "feature_columns", "lags"]
    for key in required_keys:
        if key not in artifact:
            raise ValueError(f"Model artifact is missing required key: {key}")
    return artifact


def forecast_with_artifact(monthly_df, artifact, periods_months=3):
    monthly_values = monthly_df["y"].astype(float).tolist()
    lags = int(artifact.get("lags", DEFAULT_LAG_COUNT))
    if len(monthly_values) < lags:
        raise ValueError(f"Insufficient monthly values. Need at least {lags} months, got {len(monthly_values)}")

    model = artifact["model"]
    feature_cols = artifact["feature_columns"]
    residual_std = float(artifact.get("residual_std", 0.0))
    interval_width = max(5.0, 1.96 * residual_std)

    now = datetime.now()
    first_month = pd.Timestamp(datetime(now.year, now.month, 1)) + pd.DateOffset(months=1)
    rolling = monthly_values[-lags:]

    monthly_forecast = []
    for step in range(1, periods_months + 1):
        forecast_month_ts = first_month + pd.DateOffset(months=step - 1)
        month_index = len(monthly_values) + step
        month_of_year = ((month_index - 1) % 12) + 1
        lag_mean_2 = float(np.mean(rolling[-2:]))
        lag_mean_4 = float(np.mean(rolling[-4:]))
        lag_std_4 = float(np.std(rolling[-4:]))
        lag_diff_1 = float(rolling[-1] - rolling[-2])

        feature_row = {
            "trend": month_index,
            "sin12": np.sin(2 * np.pi * month_of_year / 12.0),
            "cos12": np.cos(2 * np.pi * month_of_year / 12.0),
            "lag_mean_2": lag_mean_2,
            "lag_mean_4": lag_mean_4,
            "lag_std_4": lag_std_4,
            "lag_diff_1": lag_diff_1,
        }
        for lag in range(1, lags + 1):
            feature_row[f"lag{lag}"] = rolling[-lag]

        x_future = pd.DataFrame([feature_row])[feature_cols]
        prediction = max(0.0, float(model.predict(x_future)[0]))
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
        rolling = rolling[-lags:]

    return monthly_forecast

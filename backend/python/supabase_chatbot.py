#!/usr/bin/env python3
"""Chatbot router for Slack: Node reporting API + Python forecast pipeline."""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, parse, request

try:
    from dateutil.relativedelta import relativedelta
except Exception:  # pragma: no cover
    relativedelta = None
try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None
try:
    from google import genai
except Exception:  # pragma: no cover
    genai = None

# Ensure UTF-8 for stdin/stdout/stderr even on Windows default codepages.
for _stream_name in ("stdout", "stderr", "stdin"):
    _stream = getattr(sys, _stream_name, None)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")


env_path = Path(__file__).resolve().parents[1] / "src" / "config" / ".env"
if load_dotenv is not None:
    load_dotenv(env_path)

FORECAST_SCRIPT_PATH = Path(__file__).resolve().parent / "workload_forecast.py"
REPORTING_API_BASE = os.environ.get("NODE_REPORTING_API_URL", "http://localhost:3000").rstrip("/")
HTTP_TIMEOUT_SECONDS = int(os.environ.get("ROUTER_HTTP_TIMEOUT_SECONDS", "30"))
FORECAST_HISTORY_MONTHS = int(os.environ.get("FORECAST_HISTORY_MONTHS", "24"))

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")
genai_client = None
if GOOGLE_API_KEY and genai is not None:
    genai_client = genai.Client(api_key=GOOGLE_API_KEY)


COMMAND_SCHEMA = {
    "report:get-project-info": {
        "description": "Hämta detaljerad information om ett specifikt projekt",
        "input": "projectKey (t.ex. HULTP)",
    },
    "report:search-projects": {
        "description": "Sök efter projekt baserat på namn eller nyckel",
        "input": "sökterm (t.ex. hulta)",
    },
    "report:project-last-week-hours": {
        "description": "Hamta loggade timmar for forra veckan (mandag-sondag, svensk tid)",
        "input": "projectKey (t.ex. HULTP)",
    },
    "forecast:python-ml": {
        "description": "Köra Python ML-forecast baserat på historiska worklogs",
        "input": "antal manader (1-12)",
    },
    "report:analytics": {
        "description": "Analysera arbetsbelastning och aktivitet över tiden",
        "input": "antal manader bakat (t.ex. 6)",
    },
    "report:historical": {
        "description": "Visa historisk jämförelse av arbetsbelastning över år",
        "input": "month/year/yearsBack (valfritt)",
    },
}


def _build_conversation_context(messages):
    if not messages or len(messages) < 2:
        return ""

    context_lines = []
    for msg in messages[-4:]:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "user":
            context_lines.append(f"Användare frågade: {content[:100]}")
        elif role == "assistant":
            summary = content[:150]
            if len(content) > 150:
                summary += "..."
            context_lines.append(f"Du svarade: {summary}")

    return "\n".join(context_lines)


def _suggest_next_command(command_name, user_intent):
    intent_lower = user_intent.lower()

    suggestions = {
        "report:get-project-info": [
            ("timeline", "forecast:python-ml", "Vill du se tidsplan och prognos för projektet?"),
            ("team", "report:analytics", "Vill du se hur teamet fordelat sitt arbete?"),
            ("history", "report:historical", "Vill du se hur arbetsbelastningen utvecklats över året?"),
        ],
        "report:search-projects": [
            ("andra", "report:search-projects", "Vill du söka efter fler projekt?"),
            ("analys", "report:analytics", "Vill du analysera arbetsbelastningen?"),
        ],
        "report:analytics": [
            ("prognos", "forecast:python-ml", "Vill du se framtida prognos?"),
            ("historik", "report:historical", "Vill du jämföra med tidigare år?"),
        ],
        "forecast:python-ml": [
            ("historik", "report:historical", "Vill du jämföra prognosen mot tidigare år?"),
            ("team", "report:analytics", "Vill du se mer detaljerad teamanalys?"),
        ],
    }

    if command_name in suggestions:
        for keyword, _next_command, text in suggestions[command_name]:
            if keyword in intent_lower:
                return text
        return suggestions[command_name][0][2]

    return None


def _format_with_model(command_name, formatted_data, user_intent, messages=None):
    suggestion = _suggest_next_command(command_name, user_intent)
    conversation_context = _build_conversation_context(messages) if messages else ""

    if genai_client is None:
        return f"{formatted_data}\n\nNästa steg: {suggestion or 'Vill du utforska mer data?'}"

    context_section = ""
    if conversation_context:
        context_section = (
            "KONVERSATIONSKONTEXT (för att förstå sammanhanget):\n"
            f"{conversation_context}\n\n"
        )

    prompt = f"""
Du har fått följande data från systemet:

{context_section}KOMMANDO KORDES: {command_name}

RA DATA (redan formaterad):
{formatted_data}

ANVANDARENS NYA FRAGA: {user_intent}

INSTRUKTION:
1. Presentera data på svenska på ett naturligt sätt (2-4 meningar)
2. Gör det affärscentrerat, inte tekniskt
3. Lägg till detta förslag på nästa steg:
   "{suggestion if suggestion else "Vill du utforska mer data eller kontrollera något annat?"}"

Svara bara med den presenterade texten + nästa-steg-förslaget. Inget annat."""

    try:
        response = genai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        return response.text
    except Exception:
        return f"{formatted_data}\n\nNasta steg: {suggestion or 'Vill du utforska mer data?'}"


def _http_get_json(path, params=None):
    query = ""
    if params:
        filtered = {k: v for k, v in params.items() if v is not None and v != ""}
        if filtered:
            query = "?" + parse.urlencode(filtered)

    url = f"{REPORTING_API_BASE}{path}{query}"
    req = request.Request(url=url, method="GET")

    try:
        with request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
    except error.HTTPError as http_error:
        body = http_error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Node API HTTP {http_error.code}: {body or http_error.reason}") from http_error
    except Exception as exc:
        raise RuntimeError(f"Kunde inte anropa Node API ({url}): {exc}") from exc


def _resolve_python_executable():
    explicit = os.environ.get("PYTHON_EXECUTABLE")
    if explicit:
        return explicit
    return sys.executable or "python"


def _run_python_forecast(worklogs, forecast_months=3, include_historical=True):
    payload = {
        "worklogs": worklogs,
        "forecast_months": forecast_months,
        "include_historical": include_historical,
    }

    python_process = subprocess.run(
        [_resolve_python_executable(), str(FORECAST_SCRIPT_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    stdout = (python_process.stdout or "").strip()
    stderr = (python_process.stderr or "").strip()

    if python_process.returncode != 0:
        raise RuntimeError(stderr or stdout or "Forecast-processen misslyckades utan feltext.")

    if not stdout:
        raise RuntimeError("Forecast-processen returnerade ingen output.")

    result = json.loads(stdout)
    if not result.get("success"):
        raise RuntimeError(result.get("error", "Forecast-processen returnerade ett okänt fel."))

    return result


def _subtract_months(now, months_back):
    if relativedelta is not None:
        return now - relativedelta(months=months_back)

    year = now.year
    month = now.month - months_back
    while month <= 0:
        month += 12
        year -= 1

    # Clamp day to avoid invalid dates when shifting from long months.
    day = min(now.day, 28)
    return now.replace(year=year, month=month, day=day)


def _fetch_worklogs_for_forecast(project_key=None, months_back=FORECAST_HISTORY_MONTHS):
    start_date = _subtract_months(datetime.now(timezone.utc), months_back).isoformat()
    payload = _http_get_json(
        "/api/reporting/worklogs",
        {
            "startDate": start_date,
            "projectKey": project_key,
        },
    )
    worklogs = payload.get("worklogs") or []
    if not worklogs:
        raise RuntimeError("Ingen worklog-data tillgänglig för forecast.")
    return worklogs


def _run_forecast_pipeline(months, project_key=None):
    worklogs = _fetch_worklogs_for_forecast(project_key=project_key)
    return _run_python_forecast(worklogs, forecast_months=months, include_historical=True)


def _format_project_info(data):
    if not isinstance(data, dict):
        return "Jag kunde inte tolka projektdatan."

    project_name = data.get("projectName") or "Okänt projekt"
    project_key = data.get("projectKey") or "-"
    contributors = data.get("contributorsCount", "-")
    total_hours = data.get("totalHours") or data.get("totalSeconds", "-")
    start_date = data.get("startDate") or "Okänt"
    last_logged_issue = data.get("lastLoggedIssue") or "Ingen"

    return (
        f"Projekt: {project_name} ({project_key})\n\n"
        f"Totalt: {total_hours if total_hours is not None else '-'} timmar\n\n"
        f"Contributors: {contributors}\n\n"
        f"Startdatum: {start_date}\n\n"
        f"Senaste loggad issue: {last_logged_issue}"
    )


def _format_project_search(data):
    if not isinstance(data, list):
        return "Jag kunde inte tolka projektsokningen."
    if not data:
        return "Jag hittade inga projekt som matchar din sökning."

    lines = ["Jag hittade följande projekt:"]
    for project in data[:10]:
        name = project.get("projectName") or "Okänt projektnamn"
        key = project.get("projectKey") or "-"
        lines.append(f"- {name} ({key})")
    return "\n".join(lines)


def _format_last_week_project_hours(data):
    if not isinstance(data, dict):
        return "Jag kunde inte tolka timmarna for forra veckan."

    project_name = data.get("projectName") or "Okant projekt"
    project_key = data.get("projectKey") or "-"
    period = data.get("period") or {}
    start_date = period.get("startDate") or "-"
    end_date = period.get("endDate") or "-"
    formatted_duration = data.get("formattedDuration") or "0 timmar 0 minuter"

    return (
        f"Projekt: {project_name} ({project_key})\n"
        f"Period: {start_date} till {end_date} (mandag-sondag, svensk tid)\n"
        f"Loggad tid: {formatted_duration}"
    )


def _is_last_week_hours_request(user_text):
    lowered = user_text.lower()

    week_markers = (
        "forra veckan",
        "förra veckan",
        "last week",
    )
    time_markers = (
        "loggad",
        "timmar",
        "tid",
        "antal",
    )
    project_markers = (
        "projekt",
        "project",
    )

    has_week_marker = any(marker in lowered for marker in week_markers)
    has_time_marker = any(marker in lowered for marker in time_markers)
    has_project_marker = any(marker in lowered for marker in project_markers)

    return has_week_marker and has_time_marker and has_project_marker


def _format_forecast_summary(data):
    if not isinstance(data, dict):
        return "Jag kunde inte tolka prognosdatan."

    nested = data.get("forecast") if isinstance(data.get("forecast"), dict) else None
    monthly = []

    if nested:
        monthly = nested.get("monthly_forecast") or []

    if not monthly:
        monthly = data.get("monthly_predictions") or []

    if monthly:
        lines = ["Prognos framåt:"]
        for item in monthly[:6]:
            month = item.get("month") or item.get("period") or "Okänd period"
            hours = item.get("predicted_hours")
            if hours is None:
                hours = item.get("hours")
            lines.append(f"- {month}: {hours if hours is not None else '-'} timmar")
        return "\n".join(lines)

    summary = data.get("summary")
    if isinstance(summary, dict):
        total_hours = summary.get("total_hours", "-")
        avg_weekly = summary.get("average_weekly_hours", "-")
        return (
            "Sammanfattning:\n"
            f"- Totala timmar: {total_hours}\n"
            f"- Genomsnitt per vecka: {avg_weekly}"
        )

    return "Jag kunde inte hitta en sammanfattning i prognosdatan."


def _format_historical(data):
    if not isinstance(data, dict):
        return "Jag kunde inte tolka den historiska jamforelsen."

    current = data.get("current_period", {})
    summary = data.get("summary", {})
    lines = [
        "Historisk jämförelse:",
        (
            f"- Nuvarande period: {current.get('year', '-')}"
            f"-{str(current.get('month', '-')).zfill(2)}"
            f", timmar: {current.get('total_hours', '-')}, användare: {current.get('active_users', '-')}"
        ),
        f"- Trend: {summary.get('trend', '-')}",
        f"- Snitt timmar over ar: {summary.get('average_hours_across_years', '-')}",
    ]
    return "\n".join(lines)


def _format_analytics(data):
    if not isinstance(data, dict):
        return "Jag kunde inte tolka analysdatan."

    summary = data.get("summary", {})
    date_range = data.get("date_range", {})
    start_date = date_range.get("start_date") or date_range.get("start") or "-"
    end_date = date_range.get("end_date") or date_range.get("end") or "-"
    return (
        "Arbetsbelastningsanalys:\n"
        f"- Period: {start_date} till {end_date}\n"
        f"- Totala timmar: {summary.get('total_hours', '-')}\n"
        f"- Totalt antal worklogs: {summary.get('total_worklogs', '-')}\n"
        f"- Antal anvandare: {summary.get('unique_users', '-')}\n"
        f"- Genomsnitt per vecka: {summary.get('average_weekly_hours', '-')}"
    )


def _guess_project_query(user_text):
    match = re.search(
        r"(?:projekt(?:et)?|project)\s*(?:om|för|kring)?\s+([a-zA-Z0-9_-]+)",
        user_text,
        flags=re.IGNORECASE,
    )
    if match:
        return match.group(1)

    for pattern in [
        r"(?:info|information|detaljer|fakta)\s+(?:om\s+)?([a-zA-Z0-9_-]+)",
        r"(?:visa|berätta)\s+(?:mig\s+)?(?:info|information|detaljer|fakta|status)?\s*(?:om|för)?\s+([a-zA-Z0-9_-]+)",
        r"(?:hur\s+går|status)\s*(?:för|om)?\s+([a-zA-Z0-9_-]+)",
    ]:
        free_match = re.search(pattern, user_text, flags=re.IGNORECASE)
        if free_match:
            return free_match.group(1)

    tokens = re.findall(r"[a-zA-Z0-9_-]+", user_text)
    if not tokens:
        return ""

    stopwords = {
        "info",
        "information",
        "detaljer",
        "fakta",
        "visa",
        "berätta",
        "om",
        "för",
        "projekt",
        "projektet",
        "project",
        "hur",
        "går",
        "status",
    }
    meaningful = [token for token in tokens if token.lower() not in stopwords]
    if meaningful:
        return meaningful[-1]

    return tokens[-1]


def _is_project_info_request(user_text):
    lowered = user_text.lower()

    if "projekt" in lowered or "project" in lowered:
        return True

    info_words = ("info", "information", "detalj", "fakta", "status", "visa", "berätta")
    if any(word in lowered for word in info_words):
        return True

    if re.search(r"\b[A-Z]{2,10}\b", user_text):
        return True

    return False


def _pick_best_project(projects, user_text):
    if not projects:
        return None

    lowered = user_text.lower()
    if "projekt" in lowered or "project" in lowered:
        preferred = [
            project
            for project in projects
            if "project" in str(project.get("projectName", "")).lower()
            or "projekt" in str(project.get("projectName", "")).lower()
        ]
        if preferred:
            return preferred[0]

    return projects[0]


def _extract_last_suggestion(messages):
    if not messages:
        return None

    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            content = msg.get("content", "").lower()
            if "vill du se" in content or "vill du" in content:
                if "prognos" in content or "forecast" in content:
                    return "prognos"
                if "historik" in content or "history" in content:
                    return "historisk"
                if "analys" in content or "analytics" in content:
                    return "analys"
                if "team" in content or "timmar per person" in content:
                    return "analys"
                if "framtid" in content or "framtida" in content:
                    return "prognos"

    return None


def _get_context_project_key(messages):
    if not messages:
        return None

    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            key_match = re.search(r"\b[A-Z]{2,10}\b", content)
            if key_match:
                return key_match.group(0)

    return None


def _run_intent_command(user_text, messages=None):
    lowered = user_text.lower().strip()

    if lowered in ("ja", "jaa", "jo", "yes", "yep", "okej", "ok"):
        suggestion = _extract_last_suggestion(messages)

        if suggestion == "prognos":
            months = 3
            project_key = _get_context_project_key(messages)
            forecast_data = _run_forecast_pipeline(months=months, project_key=project_key)
            formatted = _format_forecast_summary(forecast_data)
            return _format_with_model("forecast:python-ml", formatted, "Vad ar prognosen?", messages)

        if suggestion == "historisk":
            data = _http_get_json("/api/reporting/historical", {})
            formatted = _format_historical(data)
            return _format_with_model("report:historical", formatted, "Visa historisk jamforelse", messages)

        if suggestion == "analys":
            data = _http_get_json("/api/reporting/analytics", {"monthsBack": 6})
            formatted = _format_analytics(data)
            return _format_with_model("report:analytics", formatted, "Analysera", messages)

    if lowered in ("nej", "na", "no", "nope"):
        return "Okej, vad vill du veta i stallet?"

    if _is_last_week_hours_request(user_text):
        key_match = re.search(r"\b[A-Z]{2,10}\b", user_text)
        if key_match:
            project_key = key_match.group(0)
            try:
                data = _http_get_json("/api/reporting/project-last-week-hours", {"projectKey": project_key})
                formatted = _format_last_week_project_hours(data)
                return _format_with_model("report:project-last-week-hours", formatted, user_text, messages)
            except RuntimeError:
                pass

        query = _guess_project_query(user_text)
        if not query:
            return "Jag kunde inte tolka vilket projekt du menar. Skriv garna projektnyckeln, till exempel HULTP."

        projects = _http_get_json("/api/reporting/search-projects", {"query": query})

        if isinstance(projects, list) and projects:
            first = _pick_best_project(projects, user_text) or projects[0]
            project_key = first.get("projectKey")
            if project_key:
                data = _http_get_json("/api/reporting/project-last-week-hours", {"projectKey": project_key})
                formatted = _format_last_week_project_hours(data)
                return _format_with_model("report:project-last-week-hours", formatted, user_text, messages)

        return "Jag hittade inget projekt som matchar den fragan."

    if _is_project_info_request(user_text):
        key_match = re.search(r"\b[A-Z]{2,10}\b", user_text)
        if key_match:
            project_key = key_match.group(0)
            data = _http_get_json("/api/reporting/project-info", {"projectKey": project_key})
            formatted = _format_project_info(data)
            return f"{formatted}\n\nVill du se tidsplan och prognos för projektet?"

        query = _guess_project_query(user_text)
        if not query:
            return "Jag kunde inte tolka vilket projekt du menar."

        projects = _http_get_json("/api/reporting/search-projects", {"query": query})

        if isinstance(projects, list) and projects:
            first = _pick_best_project(projects, user_text) or projects[0]
            project_key = first.get("projectKey")
            if project_key:
                project_data = _http_get_json("/api/reporting/project-info", {"projectKey": project_key})
                formatted = _format_project_info(project_data)
                return f"{formatted}\n\nVill du se tidsplan och prognos för projektet?"

        formatted = _format_project_search(projects)
        return _format_with_model("report:search-projects", formatted, user_text, messages)

    if "sok" in lowered or "hitta projekt" in lowered or "search" in lowered:
        query = _guess_project_query(user_text)
        projects = _http_get_json("/api/reporting/search-projects", {"query": query})
        formatted = _format_project_search(projects)
        return _format_with_model("report:search-projects", formatted, user_text, messages)

    if "forecast" in lowered or "prognos" in lowered:
        months_match = re.search(r"\b([1-9]|1[0-2])\b", user_text)
        months = int(months_match.group(1)) if months_match else 3
        project_key = _get_context_project_key(messages)
        forecast_data = _run_forecast_pipeline(months=months, project_key=project_key)
        formatted = _format_forecast_summary(forecast_data)
        return _format_with_model("forecast:python-ml", formatted, user_text, messages)

    if "historisk" in lowered or "year" in lowered:
        data = _http_get_json("/api/reporting/historical", {})
        formatted = _format_historical(data)
        return _format_with_model("report:historical", formatted, user_text, messages)

    if "analys" in lowered or "analytics" in lowered:
        months_match = re.search(r"\b([1-9]|1[0-9]|2[0-4])\b", user_text)
        months = int(months_match.group(1)) if months_match else 6
        data = _http_get_json("/api/reporting/analytics", {"monthsBack": months})
        formatted = _format_analytics(data)
        return _format_with_model("report:analytics", formatted, user_text, messages)

    return (
        "Jag ar nu kopplad till Node Reporting API och Python Forecast API. "
        "Fraga till exempel om projektinfo, prognos, historisk jamforelse eller analys."
    )


def ask_project_ai(messages):
    user_messages = [m.get("content", "") for m in messages if m.get("role") == "user"]
    if not user_messages:
        return "Jag behover ett anvandarmeddelande for att kunna svara."

    latest_user_message = user_messages[-1]

    try:
        return _run_intent_command(latest_user_message, messages)
    except Exception as exc:  # pragma: no cover
        return f"Kunde inte hamta data via API/router. Fel: {exc}"


def _run_chat_json_mode():
    raw = (sys.stdin.read() or "").strip()
    if not raw:
        print(json.dumps({"answer": "Tom payload till chatbot-router."}, ensure_ascii=False))
        return

    payload = json.loads(raw)
    messages = payload.get("messages", [])
    answer = ask_project_ai(messages)
    print(json.dumps({"answer": answer}, ensure_ascii=False))


if __name__ == "__main__":
    if "--chat-json" in sys.argv:
        _run_chat_json_mode()
    else:
        print("Use --chat-json and pass {'messages': [...]} on stdin.")

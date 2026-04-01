#!/usr/bin/env python3
"""Chatbot that routes user queries to npm reporting commands."""

import json
import os
import re
import subprocess
from pathlib import Path
from dotenv import load_dotenv
from google import genai


# Load environment variables from .env
env_path = Path(__file__).resolve().parents[1] / "src" / "config" / ".env"
load_dotenv(env_path)

BACKEND_DIR = Path(__file__).resolve().parents[1]
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")

if not GOOGLE_API_KEY:
    raise RuntimeError("Saknar GOOGLE_API_KEY i .env")

genai_client = genai.Client(api_key=GOOGLE_API_KEY)


COMMAND_SCHEMA = {
    "report:get-project-info": {
        "description": "Hämtar detaljerad information om ett specifikt projekt",
        "input": "projectKey (t.ex. HULTP)",
        "output": "Projektets namn, startdatum, senast loggad issue, antal contributors, totala timmar",
        "example": "npm run report:get-project-info -- HULTP",
        "relevant_for": ["projektinfo", "status", "detaljer om projekt"]
    },
    "report:search-projects": {
        "description": "Söker efter projekt baserat på namn eller nyckel",
        "input": "sökterm (t.ex. hulta)",
        "output": "Lista på matchande projekt med namn och nyckel",
        "example": "npm run report:search-projects -- hulta",
        "relevant_for": ["hitta projekt", "söka projekt"]
    },
    "report:workload-forecast": {
        "description": "Visar prognos för arbetsbelastning kommande månader",
        "input": "antal månader (t.ex. 3)",
        "output": "Förutspådd arbetsbelastning per månad",
        "example": "npm run report:workload-forecast -- 3",
        "relevant_for": ["prognos", "framtida arbetsbelastning"]
    },
    "report:analytics": {
        "description": "Analyserar arbetsbelastning och aktivitet över tiden",
        "input": "antal månader bakåt (t.ex. 6)",
        "output": "Detaljerad analys av timmar, worklogs, användare",
        "example": "npm run report:analytics -- 6",
        "relevant_for": ["analys", "statistik", "trender"]
    },
    "report:historical": {
        "description": "Visar historisk jämförelse av arbetsbelastning över år",
        "input": "ingen",
        "output": "Jämförelse mellan åren med trender",
        "example": "npm run report:historical",
        "relevant_for": ["historisk", "förändring över tid", "årlig jämförelse"]
    }
}

SYSTEM_PROMPT = """Du är en hjälpsam assistent som presenterar arbetsdata från ett internt projekthanteringssystem.

Din roll:
- Du är en NATURAL LANGUAGE INTERFACE ovanpå systemet
- Du omvandlar rå data från npm-kommandon till kort, tydlig och mänsklig text
- Du föreslår nästa relevanta steg eller command baserat på vad användaren just frågade
- Du gissar ALDRIG på data - du använder bara det systemet returnerar
- Du svarar på svenska

Systemets commands:
""" + "\n".join([
    f"- {cmd}: {schema['description']} (input: {schema['input']})"
    for cmd, schema in COMMAND_SCHEMA.items()
]) + """

Instruktioner för varje svar:
1. Summarize: Omformulera den råa datan till naturligt språk (3-5 meningar max)
2. Clarify: Gör data förståelig för en svensk affärsperson
3. Suggest: Föreslå ett naturligt nästa steg (t.ex. "Vill du se timmar per person?")
4. Never guess: Säg aldrig något som inte finns i datan du fick

Format för ditt svar:
[Ditt naturliga språk-svar]
Nästa steg: [förslag på relevant command eller fråga]
"""


def _build_conversation_context(messages):
    """Skapa en konversationskontextstring från chat-historiken."""
    if not messages or len(messages) < 2:
        return ""
    
    # Skapa en kort sammanfattning av tidigare svar (senaste 2-3 utbyten)
    context_lines = []
    for msg in messages[-4:]:  # Senaste 4 meddelanden (2 utbyten)
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "user":
            context_lines.append(f"Användare frågade: {content[:100]}")
        elif role == "assistant":
            # Ta första 150 tecken av svaret för kontext
            summary = content[:150]
            if len(content) > 150:
                summary += "..."
            context_lines.append(f"Du svarade: {summary}")
    
    return "\n".join(context_lines)


def _suggest_next_command(script_name, user_intent):
    """Föreslå nästa relevant command baserat på vad användaren frågade."""
    intent_lower = user_intent.lower()
    
    suggestions = {
        "report:get-project-info": [
            ("timeline", "report:forecast-summary", "Vill du se tidsplan och prognos för projektet?"),
            ("team", "report:analytics", "Vill du se hur teamet fördelat sitt arbete?"),
            ("history", "report:historical", "Vill du se hur projektets arbetsbelastning utvecklats över året?"),
        ],
        "report:search-projects": [
            ("andra", "report:search-projects", "Vill du söka efter fler projekt?"),
            ("analys", "report:analytics", "Vill du analysera arbetsbelastningen?"),
        ],
        "report:analytics": [
            ("prognos", "report:workload-forecast", "Vill du se framtida prognos?"),
            ("historik", "report:historical", "Vill du jämföra med tidigare år?"),
        ],
    }
    
    if script_name in suggestions:
        for keyword, command, text in suggestions[script_name]:
            if keyword in intent_lower:
                return text
        return suggestions[script_name][0][2]
    
    return None


def _format_with_model(command_name, formatted_data, user_intent, messages=None):
    """Skicka formaterad data till modellen för naturligt språkflöde med nästa-steg-förslag."""
    suggestion = _suggest_next_command(command_name, user_intent)
    conversation_context = _build_conversation_context(messages) if messages else ""
    
    context_section = ""
    if conversation_context:
        context_section = f"""KONVERSATIONSKONTEXT (för att förstå sammanhanget):
{conversation_context}

"""
    
    prompt = f"""
Du har fått följande data från systemet:

{context_section}KOMMANDO KÖRDES: {command_name}

RAÅ DATA (redan formaterad):
{formatted_data}

ANVÄNDARENS NYA FRÅGA: {user_intent}

INSTRUKTION:
1. Presentera data på svenska på ett naturligt sätt (2-4 meningar)
2. Gör det affärscentrerat, inte tekniskt
3. Lägg till detta förslag på nästa steg:
   "{suggestion if suggestion else "Vill du utforska mer data eller kontrollera något annat?"}"

Svara bara med den presenterade texten + nästa-steg-förslaget. Inget annat."""

    try:
        response = genai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt
        )
        return response.text
    except Exception as e:
        # Fallback om modellen inte svarar
        return f"{formatted_data}\n\nNästa steg: {suggestion or 'Vill du utforska mer data?'}"





def _run_npm_command(script_name, args):
    """Execute npm command and return output."""
    npm_executable = "npm.cmd" if os.name == "nt" else "npm"
    command = [npm_executable, "run", script_name, "--", *args]
    result = subprocess.run(
        command,
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    combined = "\n".join([part for part in [stdout, stderr] if part]).strip()

    if result.returncode != 0:
        raise RuntimeError(combined or "Kommandot misslyckades utan feltext.")

    return combined


def _extract_json_block(text):
    """Extract JSON block from command output."""
    if not text:
        return None

    first_object = text.find("{")
    first_array = text.find("[")

    starts = [idx for idx in (first_object, first_array) if idx != -1]
    if not starts:
        return None

    start = min(starts)

    candidate = text[start:]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _format_project_info(data):
    """Format project info JSON to readable text."""
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
        f"🕐 {total_hours if total_hours is not None else '-'} timmar\n\n"
        f"🧍 {contributors} arbetare\n\n"
        f"📅 Startdatum: {start_date}\n\n"
        f"🧩 Senaste loggad issue: {last_logged_issue}"
    )


def _format_project_search(data):
    """Format project search results."""
    if not isinstance(data, list):
        return "Jag kunde inte tolka projektsökningen."
    if not data:
        return "Jag hittade inga projekt som matchar din sökning."

    lines = ["Jag hittade följande projekt:"]
    for project in data[:10]:
        name = project.get("projectName") or "Okänt projektnamn"
        key = project.get("projectKey") or "-"
        lines.append(f"- {name} ({key})")
    return "\n".join(lines)


def _format_forecast_summary(data):
    """Format workload forecast summary."""
    if not isinstance(data, dict):
        return "Jag kunde inte tolka prognosdatan."

    forecast = data.get("forecast")
    if isinstance(forecast, list) and forecast:
        lines = ["Prognos framåt:"]
        for item in forecast[:6]:
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
    """Format historical comparison data."""
    if not isinstance(data, dict):
        return "Jag kunde inte tolka den historiska jämförelsen."

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
        f"- Snitt timmar över år: {summary.get('average_hours_across_years', '-')}",
    ]
    return "\n".join(lines)


def _format_analytics(data):
    """Format workload analytics data."""
    if not isinstance(data, dict):
        return "Jag kunde inte tolka analysdatan."

    summary = data.get("summary", {})
    date_range = data.get("date_range", {})
    return (
        "Arbetsbelastningsanalys:\n"
        f"- Period: {date_range.get('start_date', '-')} till {date_range.get('end_date', '-')}\n"
        f"- Totala timmar: {summary.get('total_hours', '-')}\n"
        f"- Totalt antal worklogs: {summary.get('total_worklogs', '-')}\n"
        f"- Antal användare: {summary.get('unique_users', '-')}\n"
        f"- Genomsnitt per vecka: {summary.get('average_weekly_hours', '-')}"
    )


def _format_command_output(script_name, output):
    parsed = _extract_json_block(output)

    if script_name == "report:get-project-info":
        return _format_project_info(parsed)
    if script_name == "report:search-projects":
        if parsed is None and output:
            return output
        return _format_project_search(parsed)
    if script_name == "report:workload-forecast":
        return _format_forecast_summary(parsed)
    if script_name == "report:forecast-summary":
        return _format_forecast_summary(parsed)
    if script_name == "report:historical":
        return _format_historical(parsed)
    if script_name == "report:analytics":
        return _format_analytics(parsed)

    return output or "Kommandot kördes men returnerade ingen data."


def _guess_project_query(user_text):
    """Extract project name/key from user text."""
    match = re.search(
        r"(?:projekt(?:et)?|project)\s*(?:om|for|för|kring)?\s+([a-zA-Z0-9_-]+)",
        user_text,
        flags=re.IGNORECASE,
    )
    if match:
        return match.group(1)

    for pattern in [
        r"(?:info|information|detaljer|fakta)\s+(?:om\s+)?([a-zA-Z0-9_-]+)",
        r"(?:visa|beratta|berätta)\s+(?:mig\s+)?(?:info|information|detaljer|fakta|status)?\s*(?:om|for|för)?\s+([a-zA-Z0-9_-]+)",
        r"(?:hur\s+gar|hur\s+går|status)\s*(?:for|för|om)?\s+([a-zA-Z0-9_-]+)",
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
        "beratta",
        "berätta",
        "om",
        "for",
        "för",
        "projekt",
        "projektet",
        "project",
        "hur",
        "gar",
        "går",
        "status",
    }
    meaningful = [token for token in tokens if token.lower() not in stopwords]
    if meaningful:
        return meaningful[-1]

    return tokens[-1]


def _is_project_info_request(user_text):
    """Check if user is asking for project information."""
    lowered = user_text.lower()

    # Explicit project keyword should continue to route to project info flow.
    if "projekt" in lowered or "project" in lowered:
        return True

    info_words = ("info", "information", "detalj", "fakta", "status", "visa", "beratta", "berätta")
    if any(word in lowered for word in info_words):
        return True

    # Project keys like HULTP should route directly to get-project-info flow.
    if re.search(r"\b[A-Z]{2,10}\b", user_text):
        return True

    return False


def _pick_best_project(projects, user_text):
    """Select best matching project from search results."""
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
    """Extraherar senaste förslaget från konversationen för 'ja'-svar."""
    if not messages:
        return None
    
    # Gå igenom assistentsvaren bakåt för att hitta senaste förslaget
    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            content = msg.get("content", "").lower()
            
            # Sök efter nyckelord som indikerar nästa steg
            if "vill du se" in content or "vill du" in content:
                if "prognos" in content or "forecast" in content:
                    return "prognos"
                elif "historik" in content or "history" in content:
                    return "historisk"
                elif "analys" in content or "analytics" in content:
                    return "analys"
                elif "team" in content or "timmar per person" in content:
                    return "analys"
                elif "framtid" in content or "framtida" in content:
                    return "prognos"
    
    return None


def _get_context_project_key(messages):
    """Extrahera projektnyckeln från konversationshistorik."""
    if not messages:
        return None
    
    # Sök efter projektnyckeln från tidigare svar
    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            # Sök efter mönster "PROJEKTNYCKELN" eller "Projekt: NAME (KEY)" 
            key_match = re.search(r"\b[A-Z]{2,10}\b", content)
            if key_match:
                return key_match.group(0)
    
    return None


def _run_intent_command(user_text, messages=None):
    """Route user message to appropriate npm command."""
    lowered = user_text.lower()
    
    # Detektera ja/nej-svar och använd konversationshistorik
    if lowered.strip() in ("ja", "jaa", "jo", "yes", "yep", "okej", "ok"):
        suggestion = _extract_last_suggestion(messages)
        
        if suggestion == "prognos":
            project_key = _get_context_project_key(messages)
            if project_key:
                output = _run_npm_command("report:workload-forecast", ["3"])
                formatted = _format_command_output("report:workload-forecast", output)
                return _format_with_model("report:workload-forecast", formatted, "Vad är prognosen?", messages)
        
        elif suggestion == "historisk":
            output = _run_npm_command("report:historical", [])
            formatted = _format_command_output("report:historical", output)
            return _format_with_model("report:historical", formatted, "Visa historisk jämförelse", messages)
        
        elif suggestion == "analys":
            output = _run_npm_command("report:analytics", ["6"])
            formatted = _format_command_output("report:analytics", output)
            return _format_with_model("report:analytics", formatted, "Analysera", messages)
    
    if lowered.strip() in ("nej", "nä", "no", "nope"):
        return "Okej, vad vill du veta istället?"

    if _is_project_info_request(user_text):
        key_match = re.search(r"\b[A-Z]{2,10}\b", user_text)
        if key_match:
            project_key = key_match.group(0)
            output = _run_npm_command("report:get-project-info", [project_key])
            formatted = _format_command_output("report:get-project-info", output)
            return (
                f"{formatted}\n\n"
                "Vill du se tidsplan och prognos för projektet?"
            )

        query = _guess_project_query(user_text)
        if not query:
            return "Jag kunde inte tolka vilket projekt du menar."

        search_output = _run_npm_command("report:search-projects", [query])
        projects = _extract_json_block(search_output)

        if isinstance(projects, list) and projects:
            first = _pick_best_project(projects, user_text) or projects[0]
            project_key = first.get("projectKey")
            if project_key:
                project_output = _run_npm_command("report:get-project-info", [project_key])
                formatted = _format_command_output("report:get-project-info", project_output)
                return (
                    f"{formatted}\n\n"
                    "Vill du se tidsplan och prognos för projektet?"
                )

        formatted = _format_command_output("report:search-projects", search_output)
        return _format_with_model("report:search-projects", formatted, user_text, messages)

    if "sok" in lowered or "sök" in lowered or "hitta projekt" in lowered or "search" in lowered:
        query = _guess_project_query(user_text)
        output = _run_npm_command("report:search-projects", [query])
        formatted = _format_command_output("report:search-projects", output)
        return _format_with_model("report:search-projects", formatted, user_text, messages)

    if "forecast" in lowered or "prognos" in lowered:
        months_match = re.search(r"\b([1-9]|1[0-2])\b", user_text)
        months = months_match.group(1) if months_match else "3"
        output = _run_npm_command("report:workload-forecast", [months])
        formatted = _format_command_output("report:workload-forecast", output)
        return _format_with_model("report:workload-forecast", formatted, user_text, messages)

    if "sammanfattning" in lowered:
        months_match = re.search(r"\b([1-9]|1[0-2])\b", user_text)
        months = months_match.group(1) if months_match else "3"
        output = _run_npm_command("report:forecast-summary", [months])
        formatted = _format_command_output("report:forecast-summary", output)
        return _format_with_model("report:forecast-summary", formatted, user_text, messages)

    if "historisk" in lowered or "year" in lowered:
        output = _run_npm_command("report:historical", [])
        formatted = _format_command_output("report:historical", output)
        return _format_with_model("report:historical", formatted, user_text, messages)

    if "analys" in lowered or "analytics" in lowered:
        months_match = re.search(r"\b([1-9]|1[0-9]|2[0-4])\b", user_text)
        months = months_match.group(1) if months_match else "6"
        output = _run_npm_command("report:analytics", [months])
        formatted = _format_command_output("report:analytics", output)
        return _format_with_model("report:analytics", formatted, user_text, messages)

    return (
        "Jag styrs nu av npm-kommandon. Fråga till exempel om projektinfo, prognos, "
        "historisk jämförelse eller analys."
    )


def ask_project_ai(messages):
    """Main entry point: process user message and return response."""
    user_messages = [m.get("content", "") for m in messages if m.get("role") == "user"]
    if not user_messages:
        return "Jag behover ett anvandarmeddelande for att kunna svara."

    latest_user_message = user_messages[-1]

    try:
        return _run_intent_command(latest_user_message, messages)
    except Exception as error:  # pragma: no cover
        return f"Kunde inte kora npm-kommandot. Fel: {error}"

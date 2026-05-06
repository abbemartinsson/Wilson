# Slack Visualization Plan

## Overview
Deliver clear insights directly in Slack by combining:
- 📊 One strong chart (image)
- 📝 Short insight text
- 🔘 Optional interaction

Focus: fast understanding, not full dashboards.

---

## Goals

### Primary
- Show that 2026 is **not declining**, but trending toward a **record year (~7,300h)**

### Secondary
- Highlight:
  - Hours vs contributors correlation
  - Partial year projection

---

## Slack Message Structure

1. **Title + Insights (text)**
2. **Chart (image)**
3. **Context (calculation)**
4. *(Optional)* Button for more details

---

## Example Output

**📊 Worklog Insights (2026)**

- Hours drop follows contributor drop  
- 2026 is *not declining*  
- Projected ~7,300h → potential record  

[Chart Image]

*Projection: 2,502h over ~34% of year → ~7,300h*

[View details]

---

## Visualization Strategy

### Single Combined Chart
- Bars: `hours per year`
- Line: `contributors`
- Highlight:
  - 2026 (partial)
  - Projection overlay

### Remove
- Multiple charts
- Tooltips
- Complex interactivity

---

## Data

### Input
```json
{
  "year": 2026,
  "hours_to_date": 2502,
  "days_elapsed": 124,
  "days_in_year": 365,
  "contributors_count": 20
}

Backend Calculates
projected_year_hours
historical comparisons
Implementation Flow
Slack command (/report)
→ Fetch data
→ Calculate projection
→ Generate chart (PNG)
→ Send Slack message (Block Kit)
Slack Blocks
Section → insight text
Image → chart
Context → projection explanation
Actions → optional button
Interactivity (Optional)
Level 1 (Recommended)
Button → “View details”
Sends new message with breakdown
Level 2
Dropdown (yearly / monthly / efficiency)
Requires more backend logic
Acceptance Criteria
Insight understood in <5 seconds
Chart shows hours + contributors
Projection clearly visible
Insight explained in text
Works on desktop & mobile
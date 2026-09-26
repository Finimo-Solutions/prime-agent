---
name: jev-decisions
description: Use Jev (TypeSafe System-One) for TYPED DECISIONS during computer-use / browser-use and evaluation — "is this the right control?", "which next action?", "does the page match?". Jev returns calibrated probabilities/confidence to threshold; the agent keeps doing the acting. Trigger whenever a UI or eval step reduces to a yes/no, a pick-one, or a rubric score.
---

# Jev decisions (TypeSafe System-One via the AOAR router)

Jev makes the **decision**; the agent does the **acting**. Offload typed judgements to Jev instead of reasoning them in prose — the answer is calibrated, cheap, fast, and thresholdable.

## When to use
- **Computer-use / browser-use gates:** feed the **accessibility tree / page text** (not a raw screenshot) as `state`, then ask a typed question:
  - "Is `<element>` the correct control for `<goal>`?" → `noul` → probability
  - "Which of these is the right next action?" → `choice` → option + probabilities
  - "How complete is the page load / how well does it match?" → `score` → rubric score
- **Website evaluation, routing, classification, policy gates** — batch many questions over one `state`.

Threshold: act on `noul >= 0.8`; escalate to the agent's own reasoning at ~0.4–0.6.

## Contract — `POST <AOAR>/agent/<sha256(NEXUS_API_KEY)>/v1/systemone`
No client key/header — the AOAR router injects identity from the URL hash. AOAR base: `http://192.168.2.253:8922` (or `$AOAR_ENDPOINT`). The lane is `/v1/systemone` (NOT `/v1/messages`, which is the normal Claude pool).

Request:
```json
{
  "model": "jev-latest",
  "state": "<content all questions refer to: AX tree / page text / message>",
  "questions": {
    "gate":   {"type":"noul","instructions":"<yes/no>","criteria":{"true":"...","false":"..."}},
    "next":   {"type":"choice","instructions":"<pick one>","criteria":{"OptA":"OptA","OptB":"OptB"}},
    "loaded": {"type":"score","instructions":"<rubric>","criteria":["blank","partial","full"]}
  }
}
```
Response: `{"model":"...","answers":{"gate":{"type":"noul","noul":0.98},"next":{"type":"choice","choice":"OptA","confidence":0.9,"probabilities":{...}},"loaded":{"type":"score","score":2.0,...}},"usage":{...}}`.

TypeScript sketch:
```ts
const base = process.env.AOAR_ENDPOINT ?? "http://192.168.2.253:8922";
const hash = createHash("sha256").update(process.env.NEXUS_API_KEY!).digest("hex");
const r = await fetch(`${base}/agent/${hash}/v1/systemone`, {
  method: "POST", headers: {"content-type":"application/json"},
  body: JSON.stringify({ model: "jev-latest", state, questions }),
});
const { answers } = await r.json();
```
(On a Mac dev box the same is available as `python3 ~/.claude/scripts/jev_ask.py noul|choice|score|ask ...`.)

## Guardrails
- ⛔ **Never put secrets, credentials, or payment PII in `state`** — it egresses to TypeSafe. Minimum context only.
- Request ≤ 256 KB, ≤ 15 s; batch questions (one `state`, many). `choice` criteria is a `{option: description}` map; `score` criteria is an ordered `["low", …, "high"]` list.

Full standard: CuraIQ-docs `specs/SPEC-JEV-SYSTEMONE-VIA-AOAR-USAGE-STANDARD.md`.

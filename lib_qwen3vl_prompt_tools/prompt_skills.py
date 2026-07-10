from __future__ import annotations

from typing import Any


ANIMA_DIT_GUIDE = """# Anima DiT prompt guide

Source: https://huggingface.co/circlestone-labs/Anima
Reviewed: 2026-07-10

Use this guide only for Anima image checkpoints.

## Model variants
- Anima Base is flexible and neutral. It benefits most from explicit quality, style, subject, and composition guidance.
- Anima Aesthetic is already quality-tuned. `masterpiece, best quality` is safe, but score tags are optional; remove score tags and lower CFG if the result becomes noisy or over-detailed.
- Anima Turbo is distilled for fast iteration. Prompt semantics stay the same; generation normally uses CFG 1 and 8-12 steps.

## Prompt grammar
- Anima understands Danbooru/Gelbooru-style tags, natural-language captions, and mixtures of both.
- Write ordinary tags in lowercase and use spaces instead of underscores. Score tags such as `score_7` keep underscores.
- Preferred tag order: quality/meta/year/safety, subject count, character, series, artist, then general appearance/action/composition tags.
- Prefix artist tags with `@`, for example `@artist name`; without `@` the artist effect is weak.
- Prompt weighting works but usually needs stronger values than SDXL, for example `(chibi:2)`.
- Preserve wildcard references such as `__artist_names__`, dynamic choices, and LoRA tags such as `<lora:name:1>` exactly. Never expand, translate, rename, or reformat them unless the user explicitly asks.

## Useful defaults
- Base positive prefix: `masterpiece, best quality, score_7, safe, `.
- Base negative: `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration`.
- Quality tags are optional on Aesthetic. Do not mechanically stack every score tag.
- Use `safe`, `sensitive`, `nsfw`, or `explicit` only when it matches the user's requested rating.

## Natural language and multi-character scenes
- Pure natural-language prompts should be descriptive and normally use at least two sentences.
- Quality and artist tags may precede natural language.
- For named characters, state the name first and then describe the visible appearance.
- For multiple characters, state the exact count and give each character a position, appearance, pose, gaze, and interaction. Do not provide only a list of names.
- Prefer concrete spatial wording such as left, center, right, foreground, behind, facing the viewer, and looking at each other.

## Limitations
- Anima targets anime, illustration, and other non-photorealistic art; do not promise strong photorealism.
- Short or underspecified prompts can produce unwanted content. Add subject, appearance, composition, and an appropriate safety tag.
- Long rendered text is unreliable.
"""


PROMPT_SKILLS = {
    "anima_dit": {
        "name": "anima_dit",
        "title": "Anima DiT prompt guide",
        "guide": ANIMA_DIT_GUIDE,
        "source": "https://huggingface.co/circlestone-labs/Anima",
        "reviewed": "2026-07-10",
    }
}


def normalize_prompt_skill_name(name: str) -> str:
    return str(name or "").strip().lower().replace("-", "_").replace(" ", "_")


def load_prompt_skill(name: str) -> dict[str, Any]:
    normalized = normalize_prompt_skill_name(name)
    skill = PROMPT_SKILLS.get(normalized)
    if skill is None:
        return {
            "ok": False,
            "name": normalized,
            "available": sorted(PROMPT_SKILLS),
            "error": f"unknown prompt skill: {normalized or name}",
        }
    return {"ok": True, **skill}


def automatic_prompt_skill(forge_preset: str = "", checkpoint: str = "") -> str:
    text = f"{forge_preset} {checkpoint}".casefold()
    return "anima_dit" if "anima" in text else ""

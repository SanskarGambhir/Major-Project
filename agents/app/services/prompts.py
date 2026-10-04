"""
Prompt files live in app/prompts/*.txt so they can be read and edited without
touching code. They use `string.Template` ($name placeholders) rather than
str.format, because prompts quote JSON examples and every `{` would otherwise
need escaping.
"""

from functools import lru_cache
from pathlib import Path
from string import Template

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"


@lru_cache
def load_prompt(name: str) -> Template:
    return Template((PROMPT_DIR / f"{name}.txt").read_text(encoding="utf-8"))


def render(name: str, **vars: object) -> str:
    """Render a prompt. A missing placeholder raises — a silent blank in a
    prompt is exactly the kind of bug that shows up only in the demo."""
    return load_prompt(name).substitute(**{k: str(v) for k, v in vars.items()})

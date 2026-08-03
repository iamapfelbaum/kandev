"""Small comment-aware TypeScript import scanner shared by frontend rules."""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    line: int


GENERATED_MARKERS = ("Code generated", "DO NOT EDIT", "@generated")
IDENTIFIER_START = re.compile(r"[A-Za-z_$]")
IDENTIFIER_PART = re.compile(r"[A-Za-z0-9_$]")


def _line_number(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def _skip_quoted(source: str, index: int, quote: str) -> tuple[str, int]:
    start = index + 1
    index += 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
        elif source[index] == quote:
            return source[start:index], index + 1
        else:
            index += 1
    return source[start:index], index


def _skip_template(source: str, index: int) -> int:
    index += 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
        elif source[index] == "`":
            return index + 1
        else:
            index += 1
    return index


def _skip_comment(source: str, index: int) -> int:
    if source.startswith("//", index):
        newline = source.find("\n", index + 2)
        return len(source) if newline < 0 else newline
    end = source.find("*/", index + 2)
    return len(source) if end < 0 else end + 2


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    index = 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
        elif source.startswith("//", index) or source.startswith("/*", index):
            index = _skip_comment(source, index)
        elif char in {'"', "'"}:
            start = index
            value, index = _skip_quoted(source, index, char)
            tokens.append(Token("string", value, _line_number(source, start)))
        elif char == "`":
            index = _skip_template(source, index)
        elif IDENTIFIER_START.fullmatch(char):
            start = index
            index += 1
            while index < len(source) and IDENTIFIER_PART.fullmatch(source[index]):
                index += 1
            tokens.append(Token("identifier", source[start:index], _line_number(source, start)))
        else:
            tokens.append(Token("punctuation", char, _line_number(source, index)))
            index += 1
    return tokens


def _string_after(tokens: list[Token], index: int) -> tuple[int, str] | None:
    next_index = index + 1
    if next_index < len(tokens) and tokens[next_index].kind == "string":
        return next_index, tokens[next_index].value
    return None


def _static_import(tokens: list[Token], index: int) -> tuple[int, str] | None:
    next_index = index + 1
    if next_index >= len(tokens) or tokens[next_index].value == ".":
        return None
    if tokens[next_index].kind == "string":
        return next_index, tokens[next_index].value

    cursor = next_index
    while cursor < len(tokens):
        token = tokens[cursor]
        if token.value == ";":
            return None
        if token.value == "from" and cursor + 1 < len(tokens):
            target = tokens[cursor + 1]
            if target.kind == "string":
                return cursor + 1, target.value
            return None
        cursor += 1
    return None


def _export_from(tokens: list[Token], index: int) -> tuple[int, str] | None:
    cursor = index + 1
    if cursor < len(tokens) and tokens[cursor].value == "type":
        cursor += 1
    if cursor >= len(tokens) or tokens[cursor].value not in {"{", "*"}:
        return None

    braces = 0
    while cursor < len(tokens):
        token = tokens[cursor]
        if token.value == "{":
            braces += 1
        elif token.value == "}":
            braces -= 1
        elif token.value == "from" and braces == 0 and cursor + 1 < len(tokens):
            target = tokens[cursor + 1]
            if target.kind == "string":
                return cursor + 1, target.value
            return None
        elif token.value == ";" and braces == 0:
            return None
        cursor += 1
    return None


def module_imports(source: str) -> list[tuple[int, str]]:
    """Return import declarations without treating comments or plain strings as code."""

    tokens = tokenize(source)
    imports: list[tuple[int, str]] = []
    for index, token in enumerate(tokens):
        if token.kind != "identifier":
            continue
        result: tuple[int, str] | None = None
        if token.value == "import":
            if index > 0 and tokens[index - 1].value == ".":
                continue
            if index + 1 < len(tokens) and tokens[index + 1].value == "(":
                result = _string_after(tokens, index + 1)
            else:
                result = _static_import(tokens, index)
        elif token.value == "export":
            result = _export_from(tokens, index)
        if result is not None:
            _, specifier = result
            imports.append((token.line, specifier))
    return imports


def is_generated(source: str) -> bool:
    return any(
        marker in line
        for line in source.splitlines()[:10]
        for marker in GENERATED_MARKERS
    )


def is_test_or_fixture(path: str) -> bool:
    parts = path.split("/")
    filename = parts[-1]
    return (
        any(part in {"__tests__", "fixtures", "__fixtures__"} for part in parts)
        or ".test." in filename
        or ".spec." in filename
        or filename.endswith("_test.ts")
        or filename.endswith("_test.tsx")
        or filename.endswith("_test.mts")
    )


def resolve_module(path: str, specifier: str) -> str | None:
    if specifier == "@/components" or specifier.startswith("@/components/"):
        return posixpath.normpath("apps/web/" + specifier[2:])
    if specifier == "@/app" or specifier.startswith("@/app/"):
        return posixpath.normpath("apps/web/" + specifier[2:])
    if specifier.startswith("."):
        source_dir = posixpath.dirname(path)
        return posixpath.normpath(posixpath.join(source_dir, specifier))
    return None


def _is_under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def is_ui_or_app_module(path: str, specifier: str) -> bool:
    resolved = resolve_module(path, specifier)
    if resolved is None:
        return False
    return _is_under(resolved, "apps/web/components") or _is_under(resolved, "apps/web/app")

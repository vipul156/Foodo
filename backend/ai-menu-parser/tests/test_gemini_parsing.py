"""Gemini client tests — defensive parsing + image hygiene."""

from __future__ import annotations

from app.clients.gemini import _parse_json, _sniff_image_type, extract_public_id_from_cloudinary_url


def test_parse_plain_json():
    assert _parse_json('{"a": 1}') == {"a": 1}


def test_parse_fenced_json():
    text = "Here you go:\n```json\n{\"categories\": []}\n```\nthanks"
    assert _parse_json(text) == {"categories": []}


def test_parse_prose_wrapped_json():
    assert _parse_json('The answer is {"ok": true} — done.') == {"ok": True}


def test_parse_garbage_returns_none():
    assert _parse_json("no json at all") is None
    assert _parse_json("") is None
    assert _parse_json("{broken") is None


def test_sniff_jpeg_png_webp():
    assert _sniff_image_type(b"\xff\xd8\xff" + b"x" * 10) == "image/jpeg"
    assert _sniff_image_type(b"\x89PNG\r\n\x1a\n" + b"x" * 10) == "image/png"
    assert _sniff_image_type(b"RIFFxxxxWEBP" + b"x" * 10) == "image/webp"
    assert _sniff_image_type(b"<html>not an image</html>") is None


def test_public_id_extraction():
    url = "https://res.cloudinary.com/demo/image/upload/e_improve/v1/foodo/x/menu.jpg"
    assert extract_public_id_from_cloudinary_url(url) == "foodo/x/menu"
    assert extract_public_id_from_cloudinary_url("https://example.com/a.jpg") is None

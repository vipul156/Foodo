"""Schema validation tests — ParsedMenu contract enforcement."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.menu import BulkPublishRequest, NormalizedItem, ParsedItem, ParsedMenu


def _item(name: str = "Paneer Tikka", price: float = 280, **kw) -> ParsedItem:
    return ParsedItem(name=name, price=price, **kw)


def test_valid_menu_passes():
    menu = ParsedMenu.model_validate(
        {
            "categories": [
                {"name": "Starters", "items": [{"name": "Paneer Tikka", "price": 280}]},
                {"name": "Beverages", "items": [{"name": "Masala Chai", "price": 40}]},
            ]
        }
    )
    assert len(menu.categories) == 2


def test_empty_parse_rejected():
    with pytest.raises(ValidationError):
        ParsedMenu.model_validate({"categories": []})


def test_price_must_be_number():
    with pytest.raises(ValidationError):
        ParsedItem(name="X", price="abc")


def test_negative_price_rejected():
    with pytest.raises(ValidationError):
        _item(price=-5)


def test_name_whitespace_cleaned():
    item = ParsedItem(name="  •  Paneer   Tikka . . . ", price=280)
    assert item.name == "Paneer Tikka"


def test_allergens_whitelisted_and_sorted():
    item = _item(allergens=["Dairy", "cashew", "monosodium"])
    assert item.allergens == ["dairy", "nuts"]


def test_currency_iso_pattern():
    with pytest.raises(ValidationError):
        _item(currency="rupees")


def test_item_bounds_trimming():
    from app.core.config import get_settings

    s = get_settings()
    many = [{"name": f"Dish {i}", "price": 100} for i in range(s.max_items_per_category + 10)]
    menu = ParsedMenu.model_validate(
        {"categories": [{"name": "Mains", "items": many}]}
    )
    assert len(menu.categories[0].items) == s.max_items_per_category


def test_bulk_request_shape():
    req = BulkPublishRequest.model_validate(
        {
            "restaurant_id": "a" * 24,
            "items": [NormalizedItem(category="Starters", name="X", price=10).model_dump()],
        }
    )
    assert req.replace_existing is False
    with pytest.raises(ValidationError):
        BulkPublishRequest.model_validate({"restaurant_id": "nope", "items": []})

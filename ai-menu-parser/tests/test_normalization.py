"""Normalization tests — deterministic post-vision cleanup."""

from __future__ import annotations

from app.schemas.menu import ParsedItem, SpiceLevel
from app.services.parser_service import infer_veg, normalize_item, normalize_menu, _titlecase_category


def test_veg_marker_wins():
    assert infer_veg(ParsedItem(name="Chicken Soup", price=100, is_veg=True)) is True


def test_nonveg_keyword_infers_false():
    assert infer_veg(ParsedItem(name="Murgh Tikka", price=220)) is False
    assert infer_veg(ParsedItem(name="Prawn Curry", price=300)) is False


def test_veg_keyword_infers_true():
    assert infer_veg(ParsedItem(name="Palak Paneer", price=240)) is True
    assert infer_veg(ParsedItem(name="Masala Dosa", price=90)) is True


def test_unknown_dish_returns_none():
    assert infer_veg(ParsedItem(name="Chef Special platter", price=350)) is None


def test_category_titlecased():
    assert _titlecase_category("main course") == "Main Course"
    assert _titlecase_category("breads and rice") == "Breads and Rice"
    assert _titlecase_category("STARTERS") == "Starters"


def test_normalize_item_rounds_price():
    item = normalize_item(
        ParsedItem(name="Dal Makhani", price=249.999, spicy_level=SpiceLevel.MEDIUM),
        "main course",
    )
    assert item.price == 250.0
    assert item.category == "Main Course"
    assert item.spicy_level == SpiceLevel.MEDIUM
    assert item.is_veg is True  # dal keyword


def test_normalize_menu_flattens_categories():
    menu = {
        "categories": [
            {"name": "starters", "items": [{"name": "Paneer Tikka", "price": 280}]},
            {"name": "breads", "items": [{"name": "Butter Naan", "price": 60}]},
        ]
    }
    from app.schemas.menu import ParsedMenu

    items = normalize_menu(ParsedMenu.model_validate(menu))
    assert [i.name for i in items] == ["Paneer Tikka", "Butter Naan"]
    assert [i.category for i in items] == ["Starters", "Breads"]

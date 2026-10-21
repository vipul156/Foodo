"""Unit tests — semantic menu ranking (lexical fallback scorer)."""

from __future__ import annotations

from app.services.menu_search import search_menu, lexical_score

MENU = [
    {"_id": "1" * 24, "restaurantId": "r1", "name": "Chicken Burger", "category": "Burgers", "price": 79, "isAvailable": True},
    {"_id": "2" * 24, "restaurantId": "r1", "name": "Paneer Tikka Starter", "category": "Starters", "price": 180, "isAvailable": True},
    {"_id": "3" * 24, "restaurantId": "r1", "name": "Onion Rings", "category": "Sides", "price": 90, "isAvailable": True},
    {"_id": "4" * 24, "restaurantId": "r1", "name": "French Fries", "category": "Sides", "price": 70, "isAvailable": False},  # unavailable
    {"_id": "5" * 24, "restaurantId": "r1", "name": "Spicy Paneer Bites", "category": "Starters", "price": 160, "isAvailable": True},
]


def test_exact_name_scores_highest():
    assert lexical_score("Chicken Burger", "Chicken Burger", "Burgers") > 0.8


def test_fuzzy_spicy_paneer_matches_starter():
    top = search_menu(MENU, "that spicy paneer starter")
    assert top, "expected at least one candidate"
    assert top[0].name in ("Spicy Paneer Bites", "Paneer Tikka Starter")


def test_unavailable_items_are_excluded():
    results = search_menu(MENU, "French Fries")
    assert all(r.name != "French Fries" for r in results)


def test_garbage_query_returns_empty():
    assert search_menu(MENU, "zzzz qwerty 12345 blah") == []


def test_limit_is_respected():
    assert len(search_menu(MENU, "paneer", limit=1)) == 1

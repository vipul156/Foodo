"""Geo math tests — haversine + bearing sanity."""

from __future__ import annotations

from app.services.geo import bearing_degrees, haversine_km


def test_zero_distance():
    assert haversine_km(12.97, 77.59, 12.97, 77.59) == 0.0


def test_known_distance():
    # ~11.1 km per 0.1 degree of latitude
    d = haversine_km(12.0, 77.0, 12.1, 77.0)
    assert 10.5 < d < 11.7


def test_bearing_north():
    assert abs(bearing_degrees(12.0, 77.0, 13.0, 77.0)) < 1


def test_bearing_east():
    assert abs(bearing_degrees(0.0, 77.0, 0.0, 78.0) - 90) < 2

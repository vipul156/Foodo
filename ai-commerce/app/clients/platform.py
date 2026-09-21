"""Breaker-wrapped clients to the platform's existing REST contracts.

Reads are server-to-server with the shared x-internal-key; identity is
always resolved server-side (never forwarded from the browser). Every
failure degrades to PlatformUnavailable so the agent says "can't reach
the kitchen right now" instead of hallucinating menus.

Known integration gap (flagged in docs): the restaurant service's
GET /api/order/my and GET /api/menu-item/all/:id are cookie-session
authenticated and have no internal-key variant yet. Until those land,
this client calls the cookie-authenticated endpoints by forwarding the
USER's cookies server-side — the same identity plane as the browser,
so the AI service can never act for a user whose session it can't
present. Swapping to x-internal-key once the internal endpoints ship
is a two-line change here.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.resilience import BreakerOpen, call_with_resilience, pools
from app.core.security import service_headers

log = get_logger(__name__)
settings = get_settings()


class PlatformUnavailable(Exception):
    """A sibling service is unreachable or its breaker is open."""


class PlatformClient:
    """Order history, menus, and cart mutations for the commerce agent."""

    def __init__(self) -> None:
        self._base = settings.restaurant_service_url

    # ─── Step 1: order history (entity resolution) ──────────────

    async def get_past_orders(
        self, user_id: str, cookie_header: str, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Recent paid orders for the user — via GET /api/order/my.

        The restaurant service enforces ownership from the forwarded
        session cookie, so a user can never read another user's history
        no matter what the LLM emits.
        """

        async def _do() -> Any:
            response = await pools.internal.get(
                f"{self._base}/api/order/my",
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        try:
            data = await call_with_resilience("orders-read", _do)
            orders = data.get("orders", []) if isinstance(data, dict) else []
            return orders[:limit]
        except BreakerOpen as exc:
            raise PlatformUnavailable("order history (circuit open)") from exc
        except PlatformUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"order history: {exc}") from exc

    # ─── Step 2: menu lookup ────────────────────────────────────

    async def get_menu(self, restaurant_id: str) -> list[dict[str, Any]]:
        """Full menu for a restaurant — GET /api/menu-item/all/:id
        (cookie-authenticated; forwarded cookies carry the session)."""

        async def _do() -> Any:
            response = await pools.internal.get(
                f"{self._base}/api/menu-item/all/{restaurant_id}"
            )
            response.raise_for_status()
            return response.json()

        try:
            data = await call_with_resilience("menu-read", _do)
            items = data.get("menuItems", []) if isinstance(data, dict) else []
            return items
        except BreakerOpen as exc:
            raise PlatformUnavailable("menu (circuit open)") from exc
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"menu: {exc}") from exc

    # ─── Step 3: cart mutation (the ONLY write path) ────────────

    async def replace_cart(
        self, user_id: str, cookie_header: str, restaurant_id: str
    ) -> None:
        """Ensure the cart belongs to exactly one restaurant — clear first."""

        async def _do() -> Any:
            response = await pools.internal.delete(
                f"{self._base}/api/cart/clear",
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        try:
            await call_with_resilience("cart-clear", _do)
        except BreakerOpen as exc:
            raise PlatformUnavailable("cart clear (circuit open)") from exc
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"cart clear: {exc}") from exc

    async def add_to_cart(
        self,
        user_id: str,
        cookie_header: str,
        restaurant_id: str,
        item_id: str,
        quantity: int,
    ) -> None:
        """POST /api/cart/add × quantity (upserts increment)."""
        last_error: Exception | None = None
        for _ in range(quantity):
            try:

                async def _do() -> Any:
                    response = await pools.internal.post(
                        f"{self._base}/api/cart/add",
                        json={"restaurantId": restaurant_id, "itemId": item_id},
                        headers={"cookie": cookie_header},
                    )
                    response.raise_for_status()
                    return response.json()

                await call_with_resilience("cart-add", _do)
            except BreakerOpen as exc:
                raise PlatformUnavailable("cart add (circuit open)") from exc
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                break
        if last_error is not None:
            raise PlatformUnavailable(f"cart add: {last_error}")

    async def set_line_quantity(
        self,
        user_id: str,
        cookie_header: str,
        item_id: str,
        quantity: int,
    ) -> None:
        """Set a cart line to an absolute quantity (0 removes the line).

        Implemented over the existing increment/decrement endpoints by
        computing the delta against the current cart — no new server
        contract required.
        """
        current = await self._current_quantity(cookie_header, item_id)
        delta = quantity - current

        async def _inc() -> Any:
            response = await pools.internal.put(
                f"{self._base}/api/cart/increase",
                json={"itemId": item_id},
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        async def _dec() -> Any:
            response = await pools.internal.put(
                f"{self._base}/api/cart/decrease",
                json={"itemId": item_id},
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        try:
            op = _inc if delta > 0 else _dec
            for _ in range(abs(delta)):
                await call_with_resilience("cart-set-qty", op)
        except BreakerOpen as exc:
            raise PlatformUnavailable("cart update (circuit open)") from exc
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"cart update: {exc}") from exc

    async def _current_quantity(self, cookie_header: str, item_id: str) -> int:
        async def _do() -> Any:
            response = await pools.internal.get(
                f"{self._base}/api/cart/all",
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        try:
            data = await call_with_resilience("cart-read", _do)
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"cart read: {exc}") from exc

        cart = data.get("cart", []) if isinstance(data, dict) else []
        for line in cart:
            item = line.get("itemId")
            item_id_val = item.get("_id") if isinstance(item, dict) else item
            if str(item_id_val) == str(item_id):
                return int(line.get("quantity", 0))
        return 0

    # ─── Payment intent (checkout hand-off) ─────────────────────

    async def create_payment_intent(
        self, user_id: str, cookie_header: str, order_id: str
    ) -> dict[str, Any]:
        """POST /api/utils/payment/create — the ONLY money-adjacent call.

        Called by the checkout confirm endpoint AFTER explicit user
        confirmation. The utils service creates the provider intent from
        the SERVER-side order record — the client (and this agent) cannot
        influence the amount.
        """

        async def _do() -> Any:
            response = await pools.internal.post(
                f"{settings.utils_service_url}/api/utils/payment/create",
                json={"orderId": order_id},
                headers={"cookie": cookie_header},
            )
            response.raise_for_status()
            return response.json()

        try:
            return await call_with_resilience("payment-create", _do)
        except BreakerOpen as exc:
            raise PlatformUnavailable("payment (circuit open)") from exc
        except Exception as exc:  # noqa: BLE001
            raise PlatformUnavailable(f"payment: {exc}") from exc

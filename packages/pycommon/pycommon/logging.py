"""Central logging configuration — structured, prefixed, quiet-by-default.

Shared by every Python service (ai-commerce, ai-dispatch, ai-menu-parser).
Each service used to carry its own copy; the only difference between the
copies was the "noisy logger" list, and every entry in those lists was
dead (none of the packages were ever imported). One shared list, filtered
to the third-party modules that are actually installed, replaces all of
them — and stays correct as the dependency set changes.
"""

from __future__ import annotations

import importlib.util
import logging
import sys

DEFAULT_FORMAT = "%(asctime)s %(levelname)-7s [%(name)s] %(message)s"
DEFAULT_DATEFMT = "%H:%M:%S"

#: Third-party loggers that are chatty at INFO. Entries whose module is
#: not installed in this container are skipped, so the list never needs
#: a per-service variant.
NOISY_LOGGERS: tuple[str, ...] = (
    "aio_pika",
    "aiormq",
    "boto3",
    "botocore",
    "google",
    "httpcore",
    "httpx",
    "motor",
    "pymongo",
    "urllib3",
)

_configured = False


def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def configure_logging(
    level: str = "INFO",
    *,
    fmt: str = DEFAULT_FORMAT,
    datefmt: str = DEFAULT_DATEFMT,
    noisy_loggers: tuple[str, ...] = NOISY_LOGGERS,
    force: bool = False,
) -> None:
    """Install a single stdout handler on the root logger (idempotent)."""
    global _configured
    if _configured and not force:
        return

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(fmt, datefmt=datefmt))

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())

    for name in noisy_loggers:
        if _installed(name):
            logging.getLogger(name).setLevel(logging.WARNING)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    """Module-scoped logger (the only logging entry point services need)."""
    return logging.getLogger(name)

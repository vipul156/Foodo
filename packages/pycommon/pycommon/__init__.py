# -*- coding: utf-8 -*-
"""Shared Python primitives for the Foodo serverless services.

The Python analog of ``@foodo/backend-common``:

  aws.py        DynamoDB / SNS / SQS primitives
  app.py        FastAPI app factory + health router
  config.py     base settings shape + cached settings factory
  deps.py       shared FastAPI dependencies
  events.py     namespaced domain-event fanout
  http.py       Mangum Lambda entrypoint
  llm.py        provider-agnostic chat-model factory (OpenAI-compatible)
  logging.py    central logging configuration
  ratelimit.py  DynamoDB fixed-window rate limiter
  resilience.py egress pools + per-dependency circuit breakers
  security.py   cookie-session + access-JWT verification
  testing.py    test-environment secret seeding

Only the AWS primitives are re-exported here: the rest pull in web-tier
dependencies (FastAPI, httpx, ...) that a consumer of ``pycommon.aws``
should not have to install. Import the module you need directly.
"""

from pycommon.aws import (  # noqa: F401
    attr_to_string,
    from_dynamo,
    handle_sqs_batch,
    publish_domain_event,
    publish_realtime_event,
    send_work_item,
    table,
    to_dynamo,
)

__all__ = [
    "attr_to_string",
    "from_dynamo",
    "handle_sqs_batch",
    "publish_domain_event",
    "publish_realtime_event",
    "send_work_item",
    "table",
    "to_dynamo",
]

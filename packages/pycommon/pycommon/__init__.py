# -*- coding: utf-8 -*-
"""Shared DynamoDB/SNS/SQS primitives (see aws.py docstring)."""

from pycommon.aws import (  # noqa: F401
    attr_to_string,
    handle_sqs_batch,
    publish_domain_event,
    publish_realtime_event,
    send_work_item,
    table,
)

__all__ = [
    "attr_to_string",
    "handle_sqs_batch",
    "publish_domain_event",
    "publish_realtime_event",
    "send_work_item",
    "table",
]

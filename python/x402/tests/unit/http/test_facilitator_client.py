"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from x402.http.facilitator_client import (
    HTTPFacilitatorClient,
    HTTPFacilitatorClientSync,
)
from x402.http.facilitator_client_base import (
    FacilitatorConfig,
    FacilitatorResponseError,
)
from x402.http.utils import safe_base64_encode
from x402.schemas import PaymentPayload, PaymentRequirements


def make_settle_response_body(**overrides: object) -> dict[str, object]:
    """Helper to create valid settle JSON body."""
    body: dict[str, object] = {
        "success": True,
        "transaction": "0xabc",
        "network": "eip155:8453",
    }
    body.update(overrides)
    return body


def make_verify_response_body(**overrides: object) -> dict[str, object]:
    """Helper to create valid verify JSON body."""
    body: dict[str, object] = {"isValid": True}
    body.update(overrides)
    return body


def make_extension_header(extensions: object) -> str:
    """Encode EXTENSION-RESPONSES header value."""
    return safe_base64_encode(json.dumps(extensions))


@pytest.mark.asyncio
async def test_async_settle_attaches_extension_responses_from_header():
    """Async settle should return header extensions when body omits them."""
    extensions = {"bazaar": {"status": "ok"}}
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body()
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(extensions)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())
    assert result.success is True
    assert result.extensions == extensions


@pytest.mark.asyncio
async def test_async_verify_attaches_extension_responses_from_header():
    """Async verify should return header extensions when body omits them."""
    extensions = {"bazaar": {"status": "ok"}}
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_verify_response_body()
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(extensions)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.verify(make_v2_payload(), make_payment_requirements())
    assert result.is_valid is True
    assert result.extensions == extensions


@pytest.mark.asyncio
async def test_async_settle_body_extensions_win_over_header():
    """Body extensions should win when both header and body provide them."""
    header_extensions = {"bazaar": {"status": "header"}}
    body_extensions = {"bazaar": {"status": "body"}}
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body(extensions=body_extensions)
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(header_extensions)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())
    assert result.extensions == body_extensions


@pytest.mark.asyncio
async def test_async_settle_empty_body_extensions_win_over_header():
    """Empty body extensions map must not be replaced by header fallback."""
    header_extensions = {"bazaar": {"status": "header"}}
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body(extensions={})
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(header_extensions)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())
    assert result.extensions == {}


@pytest.mark.asyncio
async def test_async_settle_malformed_extension_header_does_not_fail():
    """Malformed EXTENSION-RESPONSES must not fail a successful settle."""
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body()
    response.headers = {"EXTENSION-RESPONSES": "not-valid-base64!!!"}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())
    assert result.success is True
    assert result.extensions is None


@pytest.mark.asyncio
async def test_async_settle_non_object_extension_header_does_not_fail():
    """Non-object EXTENSION-RESPONSES JSON must not fail a successful settle."""
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body()
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(["not", "an", "object"])}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())
    assert result.success is True
    assert result.extensions is None


def test_sync_settle_attaches_extension_responses_from_header():
    """Sync settle should return header extensions when body omits them."""
    extensions = {"bazaar": {"status": "ok"}}
    response = MagicMock(status_code=200, text="")
    response.json.return_value = make_settle_response_body()
    response.headers = {"EXTENSION-RESPONSES": make_extension_header(extensions)}

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = client.settle(make_v2_payload(), make_payment_requirements())
    assert result.success is True
    assert result.extensions == extensions


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid PaymentRequirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_v2_payload(signature: str = "0xmock") -> PaymentPayload:
    """Helper to create valid V2 PaymentPayload."""
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
    )


@pytest.mark.asyncio
async def test_async_verify_raises_facilitator_response_error_for_invalid_json():
    """Async verify should surface invalid JSON as facilitator boundary error."""
    response = MagicMock(status_code=200, text="not-json")
    response.json.side_effect = json.JSONDecodeError("Expecting value", "not-json", 0)

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        await client.verify(make_v2_payload(), make_payment_requirements())


@pytest.mark.asyncio
async def test_async_settle_raises_facilitator_response_error_for_invalid_schema():
    """Async settle should surface schema drift as facilitator boundary error."""
    response = MagicMock(status_code=200, text='{"success": true}')
    response.json.return_value = {"success": True}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        await client.settle(make_v2_payload(), make_payment_requirements())


def test_sync_verify_raises_facilitator_response_error_for_invalid_json():
    """Sync verify should surface invalid JSON as facilitator boundary error."""
    response = MagicMock(status_code=200, text="not-json")
    response.json.side_effect = json.JSONDecodeError("Expecting value", "not-json", 0)

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        client.verify(make_v2_payload(), make_payment_requirements())


def test_sync_settle_raises_facilitator_response_error_for_invalid_schema():
    """Sync settle should surface schema drift as facilitator boundary error."""
    response = MagicMock(status_code=200, text='{"success": true}')
    response.json.return_value = {"success": True}

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        client.settle(make_v2_payload(), make_payment_requirements())

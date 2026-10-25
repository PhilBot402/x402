from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

V1_REQUIREMENTS = {
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "1000",
    "resource": "http://127.0.0.1/x",
    "description": "",
    "mimeType": "application/json",
    "payTo": "0x0000000000000000000000000000000000000002",
    "maxTimeoutSeconds": 60,
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "extra": {"name": "USDC", "version": "2"},
}

V1_PAYLOAD = {
    "x402Version": 1,
    "scheme": "exact",
    "network": "base-sepolia",
    "payload": {
        "signature": "0x" + "00" * 65,
        "authorization": {
            "from": "0x0000000000000000000000000000000000000001",
            "to": "0x0000000000000000000000000000000000000003",
            "value": "1000",
            "validAfter": "0",
            "validBefore": "9999999999",
            "nonce": "0x" + "00" * 32,
        },
    },
}


def test_verify_v1_request_returns_invalid_response():
    response = client.post(
        "/verify",
        json={"paymentPayload": V1_PAYLOAD, "paymentRequirements": V1_REQUIREMENTS},
    )

    assert response.status_code == 200
    assert response.json()["isValid"] is False


def test_verify_malformed_requirements_returns_400():
    requirements = {k: v for k, v in V1_REQUIREMENTS.items() if k != "maxAmountRequired"}

    response = client.post(
        "/verify",
        json={"paymentPayload": V1_PAYLOAD, "paymentRequirements": requirements},
    )

    assert response.status_code == 400


V2_REQUIREMENTS = {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "1000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x0000000000000000000000000000000000000002",
    "maxTimeoutSeconds": 60,
    "extra": {"name": "USDC", "version": "2"},
}


def _v2_request(payload, *, network="eip155:84532", scheme="exact", version=2):
    requirements = {**V2_REQUIREMENTS, "network": network, "scheme": scheme}
    return {
        "paymentPayload": {
            "x402Version": version,
            "resource": {"url": "http://127.0.0.1/x"},
            "accepted": dict(requirements),
            "payload": payload,
        },
        "paymentRequirements": requirements,
    }


def test_non_object_payload_returns_400():
    for path in ("/verify", "/settle"):
        for payload in ([1, 2], "x", None):
            response = client.post(path, json=_v2_request(payload))
            assert response.status_code == 400, (path, payload, response.text)


def test_invalid_x402_version_returns_400():
    body = _v2_request({}, version=9)
    for path in ("/verify", "/settle"):
        response = client.post(path, json=body)
        assert response.status_code == 400, (path, response.text)


def test_unknown_scheme_returns_unsupported_scheme():
    body = _v2_request({}, scheme="nope")
    for path in ("/verify", "/settle"):
        response = client.post(path, json=body)
        assert response.status_code == 200, (path, response.text)
        result = response.json()
        if path == "/verify":
            assert result["isValid"] is False
            assert result["invalidReason"] == "unsupported_scheme"
        else:
            assert result["success"] is False
            assert result["errorReason"] == "unsupported_scheme"


def test_unmatched_network_returns_unsupported_scheme():
    body = _v2_request({}, network="foo:1")
    for path in ("/verify", "/settle"):
        response = client.post(path, json=body)
        assert response.status_code == 200, (path, response.text)
        result = response.json()
        if path == "/verify":
            assert result["isValid"] is False
            assert result["invalidReason"] == "unsupported_scheme"
        else:
            assert result["success"] is False
            assert result["errorReason"] == "unsupported_scheme"

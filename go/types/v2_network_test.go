package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func paymentRequirementsV2JSON(t *testing.T, network string) []byte {
	t.Helper()
	body := map[string]any{
		"scheme":            "exact",
		"network":           network,
		"amount":            "10000",
		"asset":             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		"payTo":             "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
		"maxTimeoutSeconds": 60,
		"extra":             map[string]any{"name": "USDC", "version": "2"},
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal requirements: %v", err)
	}
	return data
}

func TestPaymentRequirementsV2Network(t *testing.T) {
	t.Run("accepts eip155:84532", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "eip155:84532")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts solana:devnet", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "solana:devnet")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts minimum abc:d", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "abc:d")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts 32-character reference", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")); err != nil {
			t.Fatal(err)
		}
	})

	malformed := []string{
		"base-sepolia",
		"ethereum",
		"a:",
		"a:b",
		"EIP155:84532",
		"123456789:1",
		"eip155:",
		"eip155:" + strings.Repeat("a", 33),
		"eip155:base.mainnet",
		":84532",
		"eip155:84532:extra",
	}
	for _, network := range malformed {
		t.Run("rejects "+network, func(t *testing.T) {
			if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, network)); err == nil {
				t.Fatalf("expected CAIP-2 rejection for %q", network)
			}
		})
	}
}

func TestPaymentRequirementsV1NetworkStaysLoose(t *testing.T) {
	for _, network := range []string{"base-sepolia", "eip155:84532"} {
		t.Run(network, func(t *testing.T) {
			body := map[string]any{
				"scheme":            "exact",
				"network":           network,
				"maxAmountRequired": "10000",
				"resource":          "https://api.example.com/premium-data",
				"description":       "Access to premium market data",
				"payTo":             "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
				"maxTimeoutSeconds": 60,
				"asset":             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			}
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ToPaymentRequirementsV1(data); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPaymentPayloadAndRequiredRejectMalformedNetwork(t *testing.T) {
	requirements := paymentRequirementsV2JSON(t, "eip155:base.mainnet")
	payload := []byte(`{"x402Version":2,"accepted":` + string(requirements) + `,"payload":{"signature":"0x1234"}}`)
	if _, err := ToPaymentPayload(payload); err == nil {
		t.Fatal("expected payload rejection")
	}

	required := []byte(`{"x402Version":2,"resource":{"url":"https://api.example.com/premium-data"},"accepts":[` + string(requirements) + `]}`)
	if _, err := ToPaymentRequired(required); err == nil {
		t.Fatal("expected payment-required rejection")
	}
}

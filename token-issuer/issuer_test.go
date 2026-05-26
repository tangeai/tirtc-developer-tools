package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestDeterministicSigningVector(t *testing.T) {
	nonce := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	result, err := Sign(SigningInput{
		RemoteID:        "device-001",
		Subject:         "subject-test",
		TTLSeconds:      300,
		AccessKeyID:     "ak-test",
		SecretKeyID:     "sid-test",
		DeviceSecretKey: "device-secret",
		Now:             time.Unix(1700000000, 0),
		NonceBytes:      nonce,
	})
	if err != nil {
		t.Fatalf("Sign returned error: %v", err)
	}
	const expected = "v1.eyJzdWIiOiJzdWJqZWN0LXRlc3QiLCJzY29wZSI6ImNvbm5lY3Q6ZGV2aWNlOi8vZGV2aWNlLTAwMSIsImlzcyI6ImFrLXRlc3QiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAwMDMwMCwibm9uY2UiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3In0.ttJRiSYSBjJIMXLi9ZTufCjaxPHYojtkH6VProqdB1U"
	if result.Token != expected {
		t.Fatalf("token mismatch\nwant: %s\n got: %s", expected, result.Token)
	}
	parts := strings.Split(result.Token, ".")
	if len(parts) != 3 {
		t.Fatalf("unexpected token format: %s", result.Token)
	}
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var claims Claims
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		t.Fatalf("unmarshal claims: %v", err)
	}
	if claims.Scope != "connect:device://device-001" || claims.Nonce != "AAECAwQFBgcICQoLDA0ODw" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestRemoteIDNormalizationMatchesAccessServerScope(t *testing.T) {
	deviceID, err := DeviceIDFromRemoteID("device://device-001")
	if err != nil {
		t.Fatalf("DeviceIDFromRemoteID returned error: %v", err)
	}
	if deviceID != "device-001" {
		t.Fatalf("unexpected device id: %s", deviceID)
	}
	if _, err := DeviceIDFromRemoteID("user://device-001"); err == nil {
		t.Fatalf("expected invalid scheme to fail")
	}
}

func TestValidationRejectsInvalidTTL(t *testing.T) {
	err := ValidateInput(SigningInput{
		RemoteID:        "device-001",
		AccessKeyID:     "ak",
		SecretKeyID:     "sid",
		DeviceSecretKey: "device-secret",
		TTLSeconds:      MaxTokenTTLSeconds + 1,
	})
	var userErr *UserError
	if !errors.As(err, &userErr) {
		t.Fatalf("expected UserError, got %v", err)
	}
	if userErr.ReasonCode != ReasonInvalidRequest || userErr.Field != "ttl_seconds" {
		t.Fatalf("unexpected error: %+v", userErr)
	}
}

func TestValidationReportsMissingSecretByEnvName(t *testing.T) {
	err := ValidateInput(SigningInput{
		RemoteID:    "device-001",
		AccessKeyID: "ak",
		SecretKeyID: "sid",
	})
	var userErr *UserError
	if !errors.As(err, &userErr) {
		t.Fatalf("expected UserError, got %v", err)
	}
	if userErr.ReasonCode != ReasonMissingRequiredInput || userErr.Field != "TIRTC_DEVICE_SECRET_KEY" {
		t.Fatalf("unexpected error: %+v", userErr)
	}
	if strings.Contains(userErr.Message, "device-secret") {
		t.Fatalf("error leaked secret: %s", userErr.Message)
	}
}

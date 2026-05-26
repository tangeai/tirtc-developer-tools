package issuer

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssueJSONUsesFlagOverEnvAndRedactsErrors(t *testing.T) {
	t.Setenv("TIRTC_ACCESS_KEY_ID", "env-ak")
	t.Setenv("TIRTC_SECRET_KEY_ID", "env-sid")
	t.Setenv("TIRTC_DEVICE_SECRET_KEY", "env-device-secret")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run([]string{
		"issue",
		"--remote-id", "device-001",
		"--access-key-id", "flag-ak",
		"--secret-key-id", "flag-sid",
		"--device-secret-key", "flag-device-secret",
		"--json",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("issue code=%d stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}
	if strings.Contains(stdout.String(), "flag-device-secret") || strings.Contains(stderr.String(), "flag-device-secret") {
		t.Fatalf("secret leaked in output")
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	data := envelope["data"].(map[string]interface{})
	payload := data["payload"].(map[string]interface{})
	if payload["iss"] != "flag-ak" {
		t.Fatalf("flag did not override env: %+v", payload)
	}
	payloadJSON, ok := data["payloadJson"].(string)
	if !ok || !strings.Contains(payloadJSON, `"scope":"connect:device://device-001"`) {
		t.Fatalf("unexpected payloadJson: %+v", data)
	}
	if _, ok := data["claims"]; ok {
		t.Fatalf("legacy claims field must not be present: %+v", data)
	}
}

func TestHTTPRejectsSecretAndAuthLookingFields(t *testing.T) {
	config := secretConfig{accessKeyID: "ak", secretKeyID: "sid", deviceSecretKey: "device-secret"}
	request := httptest.NewRequest(http.MethodPost, "/v1/tokens", strings.NewReader(`{"remote_id":"device-001","device_secret_key":"nope"}`))
	response := httptest.NewRecorder()
	handleTokenRequest(response, request, config, "", 300)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "nope") {
		t.Fatalf("secret leaked in error body: %s", response.Body.String())
	}
}

func TestHTTPIssuesToken(t *testing.T) {
	config := secretConfig{accessKeyID: "ak", secretKeyID: "sid", deviceSecretKey: "device-secret"}
	request := httptest.NewRequest(http.MethodPost, "/v1/tokens", strings.NewReader(`{"remote_id":"device-001"}`))
	response := httptest.NewRecorder()
	handleTokenRequest(response, request, config, "", 300)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	token, ok := body["token"].(string)
	if !ok || !strings.HasPrefix(token, "v1.") {
		t.Fatalf("unexpected token response: %+v", body)
	}
	payload, ok := body["payload"].(map[string]interface{})
	if !ok || payload["scope"] != "connect:device://device-001" {
		t.Fatalf("unexpected payload response: %+v", body)
	}
	if _, ok := body["claims"]; ok {
		t.Fatalf("legacy claims field must not be present: %+v", body)
	}
}

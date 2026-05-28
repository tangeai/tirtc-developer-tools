package issuer

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestHTTPUsesDeviceSecretMap(t *testing.T) {
	config := secretConfig{
		accessKeyID: "ak",
		secretKeyID: "sid",
		deviceSecretMap: map[string]string{
			"device-001": "device-001-secret",
			"device-002": "device-002-secret",
		},
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/tokens", strings.NewReader(`{"remote_id":"device://device-002"}`))
	response := httptest.NewRecorder()
	handleTokenRequest(response, request, config, "", 300)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	payload := body["payload"].(map[string]interface{})
	if payload["scope"] != "connect:device://device-002" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestHTTPRejectsMissingDeviceSecretMapEntry(t *testing.T) {
	config := secretConfig{
		accessKeyID: "ak",
		secretKeyID: "sid",
		deviceSecretMap: map[string]string{
			"device-001": "device-001-secret",
		},
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/tokens", strings.NewReader(`{"remote_id":"device-404"}`))
	response := httptest.NewRecorder()
	handleTokenRequest(response, request, config, "", 300)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"field":"remote_id"`) {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "device-001-secret") {
		t.Fatalf("secret leaked in error body: %s", response.Body.String())
	}
}

func TestLoadDeviceSecretMapNormalizesKeys(t *testing.T) {
	tempDir := t.TempDir()
	mapPath := filepath.Join(tempDir, "device-secrets.json")
	if err := os.WriteFile(mapPath, []byte(`{"device://device-001":"secret-001","device-002":"secret-002"}`), 0o600); err != nil {
		t.Fatalf("write map: %v", err)
	}
	config, err := resolveSecretConfig("ak", "sid", "", mapPath)
	if err != nil {
		t.Fatalf("resolveSecretConfig returned error: %v", err)
	}
	secret, err := config.deviceSecretForRemoteID("device-001")
	if err != nil {
		t.Fatalf("deviceSecretForRemoteID returned error: %v", err)
	}
	if secret != "secret-001" {
		t.Fatalf("unexpected secret: %s", secret)
	}
}

func TestTokenServiceBaseURLUsesAdvertiseHost(t *testing.T) {
	if got := tokenServiceBaseURL("0.0.0.0", "192.168.31.68", 8966); got != "http://192.168.31.68:8966" {
		t.Fatalf("unexpected service url: %s", got)
	}
	if got := tokenServiceBaseURL("::", "fd00::1", 8966); got != "http://[fd00::1]:8966" {
		t.Fatalf("unexpected ipv6 service url: %s", got)
	}
}

func TestServeStartupOutputShowsBaseURLAndProtocolDetails(t *testing.T) {
	var stderr bytes.Buffer
	writeServeStartup(&stderr, "0.0.0.0:8966", "http://192.168.31.68:8966")
	output := stderr.String()
	for _, want := range []string{
		"Token 签发服务地址:",
		"http://192.168.31.68:8966",
		"POST /v1/tokens",
		`{"remote_id":"device://your_device_id"}`,
		`{"token":"v1...","payload":{"scope":"connect:device://your_device_id"}}`,
		"curl -sS -X POST 'http://192.168.31.68:8966/v1/tokens'",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("startup output missing %q:\n%s", want, output)
		}
	}
	if strings.Contains(output, "device_secret") {
		t.Fatalf("startup output leaked secret wording:\n%s", output)
	}
}

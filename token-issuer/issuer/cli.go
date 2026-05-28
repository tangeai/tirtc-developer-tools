package issuer

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

const (
	defaultHost = "0.0.0.0"
	defaultPort = 8966
	tokenPath   = "/v1/tokens"

	advertiseHostEnv = "TIRTC_TOKEN_ISSUER_ADVERTISE_HOST"
)

type outputEnvelope struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
	Error   interface{} `json:"error,omitempty"`
}

type errorPayload struct {
	Code    ReasonCode        `json:"code"`
	Message string            `json:"message"`
	Data    map[string]string `json:"data,omitempty"`
}

type httpTokenRequest struct {
	RemoteID   string `json:"remote_id"`
	Subject    string `json:"subject,omitempty"`
	TTLSeconds *int64 `json:"ttl_seconds,omitempty"`
}

type secretConfig struct {
	accessKeyID     string
	secretKeyID     string
	deviceSecretKey string
	deviceSecretMap map[string]string
}

type tokenResponse struct {
	Token       string `json:"token"`
	Payload     Claims `json:"payload"`
	PayloadJSON string `json:"payloadJson,omitempty"`
}

func Run(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: tirtc-issuer-cli issue|serve")
		return 2
	}
	switch args[0] {
	case "issue":
		return runIssue(args[1:], stdout, stderr)
	case "serve":
		return runServe(args[1:], stdout, stderr)
	case "-h", "--help", "help":
		fmt.Fprintln(stdout, "usage: tirtc-issuer-cli issue|serve")
		return 0
	default:
		writeError(stdout, stderr, false, Invalid("command", "unknown command: "+args[0]))
		return 2
	}
}

func runIssue(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("issue", flag.ContinueOnError)
	fs.SetOutput(stderr)
	remoteID := fs.String("remote-id", "", "remote id to connect")
	subject := fs.String("subject", "", "token subject")
	ttlSeconds := fs.Int64("ttl-seconds", DefaultTTLSeconds, "token ttl seconds")
	accessKeyID := fs.String("access-key-id", "", "access key id")
	secretKeyID := fs.String("secret-key-id", "", "secret key id")
	deviceSecretKey := fs.String("device-secret-key", "", "device secret key")
	deviceSecretMapPath := fs.String("device-secret-map", "", "JSON file mapping device_id to device_secret_key")
	jsonOutput := fs.Bool("json", false, "print JSON envelope")
	tokenOnly := fs.Bool("token-only", false, "print token only")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	config, err := resolveSecretConfig(*accessKeyID, *secretKeyID, *deviceSecretKey, *deviceSecretMapPath)
	if err != nil {
		return writeError(stdout, stderr, *jsonOutput, err)
	}
	resolvedDeviceSecretKey, err := config.deviceSecretForRemoteID(strings.TrimSpace(*remoteID))
	if err != nil {
		return writeError(stdout, stderr, *jsonOutput, err)
	}
	result, err := Sign(SigningInput{
		RemoteID:        strings.TrimSpace(*remoteID),
		Subject:         strings.TrimSpace(*subject),
		TTLSeconds:      *ttlSeconds,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: resolvedDeviceSecretKey,
	})
	if err != nil {
		return writeError(stdout, stderr, *jsonOutput, err)
	}
	if *tokenOnly {
		fmt.Fprintln(stdout, result.Token)
		return 0
	}
	if *jsonOutput {
		payloadJSON, err := json.Marshal(result.Claims)
		if err != nil {
			return writeError(stdout, stderr, true, Internal("failed to encode claims"))
		}
		writeJSON(stdout, outputEnvelope{
			Code:    0,
			Message: "OK",
			Data: tokenResponse{
				Token:       result.Token,
				Payload:     result.Claims,
				PayloadJSON: string(payloadJSON),
			},
		})
		return 0
	}
	fmt.Fprintln(stdout, "Issued token for scope "+result.Claims.Scope)
	fmt.Fprintln(stdout, "Expires unix seconds: "+strconv.FormatInt(result.Claims.Expires, 10))
	fmt.Fprintln(stdout, "Token:")
	fmt.Fprintln(stdout, result.Token)
	return 0
}

func runServe(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	host := fs.String("host", defaultHost, "listen host")
	port := fs.Int("port", defaultPort, "listen port")
	advertiseHost := fs.String("advertise-host", "", "host printed in the client-facing service address")
	subject := fs.String("subject", "", "default token subject")
	ttlSeconds := fs.Int64("ttl-seconds", DefaultTTLSeconds, "default token ttl seconds")
	accessKeyID := fs.String("access-key-id", "", "access key id")
	secretKeyID := fs.String("secret-key-id", "", "secret key id")
	deviceSecretKey := fs.String("device-secret-key", "", "device secret key")
	deviceSecretMapPath := fs.String("device-secret-map", "", "JSON file mapping device_id to device_secret_key")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	config, err := resolveSecretConfig(*accessKeyID, *secretKeyID, *deviceSecretKey, *deviceSecretMapPath)
	if err != nil {
		return writeError(stdout, stderr, false, err)
	}
	preflightDeviceSecretKey := config.deviceSecretKey
	if len(config.deviceSecretMap) > 0 {
		preflightDeviceSecretKey = "device-secret-map-preflight"
	}
	if err := ValidateInput(SigningInput{
		RemoteID:        "preflight",
		Subject:         strings.TrimSpace(*subject),
		TTLSeconds:      *ttlSeconds,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: preflightDeviceSecretKey,
	}); err != nil {
		return writeError(stdout, stderr, false, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc(tokenPath, func(response http.ResponseWriter, request *http.Request) {
		handleTokenRequest(response, request, config, strings.TrimSpace(*subject), *ttlSeconds)
	})
	addr := fmt.Sprintf("%s:%d", strings.TrimSpace(*host), *port)
	serviceURL := tokenServiceBaseURL(strings.TrimSpace(*host), choose(*advertiseHost, os.Getenv(advertiseHostEnv)), *port)
	writeServeStartup(stderr, addr, serviceURL)
	if err := http.ListenAndServe(addr, mux); err != nil {
		return writeError(stdout, stderr, false, Internal("issuer server failed"))
	}
	return 0
}

func writeServeStartup(stderr io.Writer, listenAddr string, serviceURL string) {
	endpointURL := serviceURL + tokenPath
	fmt.Fprintln(stderr, "[tirtc-issuer] listening on "+listenAddr+"; secrets loaded from env/flags")
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "Token 签发服务地址:")
	fmt.Fprintln(stderr, "  "+serviceURL)
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "HTTP API:")
	fmt.Fprintln(stderr, "  POST "+tokenPath)
	fmt.Fprintln(stderr, "  Content-Type: application/json")
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "Request:")
	fmt.Fprintln(stderr, `  {"remote_id":"device://your_device_id"}`)
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "Response:")
	fmt.Fprintln(stderr, `  {"token":"v1...","payload":{"scope":"connect:device://your_device_id"}}`)
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "cURL:")
	fmt.Fprintln(stderr, "  curl -sS -X POST '"+endpointURL+"' \\")
	fmt.Fprintln(stderr, "    -H 'Content-Type: application/json' \\")
	fmt.Fprintln(stderr, `    --data '{"remote_id":"device://your_device_id"}'`)
}

func tokenServiceBaseURL(listenHost string, advertiseHost string, port int) string {
	host := strings.TrimSpace(advertiseHost)
	if host == "" {
		host = strings.TrimSpace(listenHost)
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = firstNonLoopbackIPv4()
		if host == "" {
			host = "127.0.0.1"
		}
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

func firstNonLoopbackIPv4() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP == nil || ipNet.IP.IsLoopback() {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil {
			continue
		}
		return ip.String()
	}
	return ""
}

func handleTokenRequest(response http.ResponseWriter, request *http.Request, config secretConfig, defaultSubject string, defaultTTLSeconds int64) {
	if request.Method != http.MethodPost {
		writeHTTPError(response, http.StatusNotFound, Invalid("path", "not found"))
		return
	}
	var raw map[string]json.RawMessage
	body, err := io.ReadAll(io.LimitReader(request.Body, 4096))
	if err != nil {
		writeHTTPError(response, http.StatusBadRequest, Invalid("body", "failed to read request body"))
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var parsed httpTokenRequest
	if err := decoder.Decode(&parsed); err != nil {
		writeHTTPError(response, http.StatusBadRequest, Invalid("body", "invalid JSON request"))
		return
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		writeHTTPError(response, http.StatusBadRequest, Invalid("body", "invalid JSON request"))
		return
	}
	for field := range raw {
		switch field {
		case "remote_id", "subject", "ttl_seconds":
		case "access_key_id", "secret_key_id", "device_secret_key", "secret", "authorization", "session", "tenant_id", "user_id", "owner_id", "device_acl":
			writeHTTPError(response, http.StatusBadRequest, Invalid(field, "field is not accepted by this issuer"))
			return
		default:
			writeHTTPError(response, http.StatusBadRequest, Invalid(field, "unknown field"))
			return
		}
	}
	ttl := defaultTTLSeconds
	if parsed.TTLSeconds != nil {
		ttl = *parsed.TTLSeconds
	}
	subject := defaultSubject
	if strings.TrimSpace(parsed.Subject) != "" {
		subject = strings.TrimSpace(parsed.Subject)
	}
	resolvedDeviceSecretKey, err := config.deviceSecretForRemoteID(strings.TrimSpace(parsed.RemoteID))
	if err != nil {
		writeHTTPError(response, http.StatusBadRequest, err)
		return
	}
	result, err := Sign(SigningInput{
		RemoteID:        strings.TrimSpace(parsed.RemoteID),
		Subject:         subject,
		TTLSeconds:      ttl,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: resolvedDeviceSecretKey,
	})
	if err != nil {
		writeHTTPError(response, http.StatusBadRequest, err)
		return
	}
	writeHTTPJSON(response, http.StatusOK, map[string]interface{}{
		"token":   result.Token,
		"payload": result.Claims,
	})
}

func resolveSecretConfig(accessKeyID string, secretKeyID string, deviceSecretKey string, deviceSecretMapPath string) (secretConfig, error) {
	resolvedMapPath := choose(deviceSecretMapPath, os.Getenv("TIRTC_DEVICE_SECRET_MAP"))
	deviceSecretMap, err := loadDeviceSecretMap(resolvedMapPath)
	if err != nil {
		return secretConfig{}, err
	}
	return secretConfig{
		accessKeyID:     choose(accessKeyID, os.Getenv("TIRTC_ACCESS_KEY_ID")),
		secretKeyID:     choose(secretKeyID, os.Getenv("TIRTC_SECRET_KEY_ID")),
		deviceSecretKey: choose(deviceSecretKey, os.Getenv("TIRTC_DEVICE_SECRET_KEY")),
		deviceSecretMap: deviceSecretMap,
	}, nil
}

func loadDeviceSecretMap(filePath string) (map[string]string, error) {
	normalizedPath := strings.TrimSpace(filePath)
	if normalizedPath == "" {
		return nil, nil
	}
	content, err := os.ReadFile(normalizedPath)
	if err != nil {
		return nil, Invalid("device_secret_map", "failed to read device secret map")
	}
	var raw map[string]string
	if err := json.Unmarshal(content, &raw); err != nil {
		return nil, Invalid("device_secret_map", "device secret map must be a JSON object")
	}
	if len(raw) == 0 {
		return nil, Invalid("device_secret_map", "device secret map must not be empty")
	}
	normalized := make(map[string]string, len(raw))
	for remoteID, secret := range raw {
		deviceID, err := DeviceIDFromRemoteID(remoteID)
		if err != nil {
			return nil, Invalid("device_secret_map", "device secret map contains invalid device id")
		}
		trimmedSecret := strings.TrimSpace(secret)
		if trimmedSecret == "" {
			return nil, Invalid("device_secret_map", "device secret map contains empty device secret key")
		}
		if _, exists := normalized[deviceID]; exists {
			return nil, Invalid("device_secret_map", "device secret map contains duplicate normalized device id")
		}
		normalized[deviceID] = trimmedSecret
	}
	return normalized, nil
}

func (config secretConfig) deviceSecretForRemoteID(remoteID string) (string, error) {
	if len(config.deviceSecretMap) > 0 {
		deviceID, err := DeviceIDFromRemoteID(remoteID)
		if err != nil {
			return "", err
		}
		secret, ok := config.deviceSecretMap[deviceID]
		if !ok {
			return "", Invalid("remote_id", "device secret key not found for remote_id")
		}
		return secret, nil
	}
	return config.deviceSecretKey, nil
}

func choose(explicit string, env string) string {
	if strings.TrimSpace(explicit) != "" {
		return strings.TrimSpace(explicit)
	}
	return strings.TrimSpace(env)
}

func writeError(stdout io.Writer, stderr io.Writer, jsonOutput bool, err error) int {
	reason := ReasonOf(err)
	message := "internal error"
	field := ""
	var userErr *UserError
	if errors.As(err, &userErr) {
		message = userErr.Message
		field = userErr.Field
	} else if err != nil && err.Error() != "" {
		message = err.Error()
	}
	if jsonOutput {
		data := map[string]string{"reasonCode": string(reason)}
		if field != "" {
			data["field"] = field
		}
		writeJSON(stdout, outputEnvelope{Code: ExitCode(reason), Message: message, Data: data})
	} else {
		fmt.Fprintln(stderr, "Error ("+string(reason)+"): "+message)
	}
	return ExitCode(reason)
}

func writeHTTPError(response http.ResponseWriter, status int, err error) {
	reason := ReasonOf(err)
	message := "internal error"
	field := ""
	var userErr *UserError
	if errors.As(err, &userErr) {
		message = userErr.Message
		field = userErr.Field
	} else if err != nil && err.Error() != "" {
		message = err.Error()
	}
	data := map[string]string{}
	if field != "" {
		data["field"] = field
	}
	writeHTTPJSON(response, status, map[string]interface{}{
		"error": errorPayload{Code: reason, Message: message, Data: data},
	})
}

func writeHTTPJSON(response http.ResponseWriter, status int, value interface{}) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeJSON(writer io.Writer, value interface{}) {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

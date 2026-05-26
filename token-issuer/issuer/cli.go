package issuer

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

const (
	defaultHost = "0.0.0.0"
	defaultPort = 8966
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
	jsonOutput := fs.Bool("json", false, "print JSON envelope")
	tokenOnly := fs.Bool("token-only", false, "print token only")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	config := resolveSecretConfig(*accessKeyID, *secretKeyID, *deviceSecretKey)
	result, err := Sign(SigningInput{
		RemoteID:        strings.TrimSpace(*remoteID),
		Subject:         strings.TrimSpace(*subject),
		TTLSeconds:      *ttlSeconds,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: config.deviceSecretKey,
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
	subject := fs.String("subject", "", "default token subject")
	ttlSeconds := fs.Int64("ttl-seconds", DefaultTTLSeconds, "default token ttl seconds")
	accessKeyID := fs.String("access-key-id", "", "access key id")
	secretKeyID := fs.String("secret-key-id", "", "secret key id")
	deviceSecretKey := fs.String("device-secret-key", "", "device secret key")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	config := resolveSecretConfig(*accessKeyID, *secretKeyID, *deviceSecretKey)
	if err := ValidateInput(SigningInput{
		RemoteID:        "preflight",
		Subject:         strings.TrimSpace(*subject),
		TTLSeconds:      *ttlSeconds,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: config.deviceSecretKey,
	}); err != nil {
		return writeError(stdout, stderr, false, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/tokens", func(response http.ResponseWriter, request *http.Request) {
		handleTokenRequest(response, request, config, strings.TrimSpace(*subject), *ttlSeconds)
	})
	addr := fmt.Sprintf("%s:%d", strings.TrimSpace(*host), *port)
	fmt.Fprintln(stderr, "[tirtc-issuer] listening on "+addr+"; secrets loaded from env/flags")
	if err := http.ListenAndServe(addr, mux); err != nil {
		return writeError(stdout, stderr, false, Internal("issuer server failed"))
	}
	return 0
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
	result, err := Sign(SigningInput{
		RemoteID:        strings.TrimSpace(parsed.RemoteID),
		Subject:         subject,
		TTLSeconds:      ttl,
		AccessKeyID:     config.accessKeyID,
		SecretKeyID:     config.secretKeyID,
		DeviceSecretKey: config.deviceSecretKey,
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

func resolveSecretConfig(accessKeyID string, secretKeyID string, deviceSecretKey string) secretConfig {
	return secretConfig{
		accessKeyID:     choose(accessKeyID, os.Getenv("TIRTC_ACCESS_KEY_ID")),
		secretKeyID:     choose(secretKeyID, os.Getenv("TIRTC_SECRET_KEY_ID")),
		deviceSecretKey: choose(deviceSecretKey, os.Getenv("TIRTC_DEVICE_SECRET_KEY")),
	}
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

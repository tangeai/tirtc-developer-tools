package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	DefaultSubject       = "devtools-cli"
	DefaultTTLSeconds    = 300
	MaxTokenTTLSeconds   = 86400
	DefaultNonceByteSize = 16
)

type ReasonCode string

const (
	ReasonMissingRequiredInput ReasonCode = "missing_required_input"
	ReasonInvalidRequest       ReasonCode = "invalid_request"
	ReasonInternalError        ReasonCode = "internal_error"
)

type UserError struct {
	ReasonCode ReasonCode `json:"reasonCode"`
	Message    string     `json:"message"`
	Field      string     `json:"field,omitempty"`
}

func (e *UserError) Error() string {
	return e.Message
}

type SigningInput struct {
	RemoteID        string
	Subject         string
	TTLSeconds      int64
	AccessKeyID     string
	SecretKeyID     string
	DeviceSecretKey string
	Now             time.Time
	NonceBytes      []byte
}

type Claims struct {
	Subject string `json:"sub"`
	Scope   string `json:"scope"`
	Issuer  string `json:"iss"`
	Issued  int64  `json:"iat"`
	Expires int64  `json:"exp"`
	Nonce   string `json:"nonce"`
}

type SignedToken struct {
	Token  string `json:"token"`
	Claims Claims `json:"claims"`
}

func Missing(field string) *UserError {
	return &UserError{
		ReasonCode: ReasonMissingRequiredInput,
		Message:    "missing required input: " + field,
		Field:      field,
	}
}

func Invalid(field string, message string) *UserError {
	return &UserError{
		ReasonCode: ReasonInvalidRequest,
		Message:    message,
		Field:      field,
	}
}

func Internal(message string) *UserError {
	return &UserError{
		ReasonCode: ReasonInternalError,
		Message:    message,
	}
}

func NormalizeSubject(subject string) string {
	if subject == "" {
		return DefaultSubject
	}
	return subject
}

func NormalizeTTL(ttlSeconds int64) int64 {
	if ttlSeconds == 0 {
		return DefaultTTLSeconds
	}
	return ttlSeconds
}

func ValidateInput(input SigningInput) error {
	if strings.TrimSpace(input.RemoteID) == "" {
		return Missing("remote_id")
	}
	if _, err := DeviceIDFromRemoteID(input.RemoteID); err != nil {
		return err
	}
	if input.AccessKeyID == "" {
		return Missing("TIRTC_ACCESS_KEY_ID")
	}
	if input.SecretKeyID == "" {
		return Missing("TIRTC_SECRET_KEY_ID")
	}
	if input.DeviceSecretKey == "" {
		return Missing("TIRTC_DEVICE_SECRET_KEY")
	}
	ttlSeconds := NormalizeTTL(input.TTLSeconds)
	if ttlSeconds <= 0 {
		return Invalid("ttl_seconds", "ttl_seconds must be positive")
	}
	if ttlSeconds > MaxTokenTTLSeconds {
		return Invalid("ttl_seconds", fmt.Sprintf("ttl_seconds must be <= %d", MaxTokenTTLSeconds))
	}
	if len(input.NonceBytes) > 0 && len(input.NonceBytes) != DefaultNonceByteSize {
		return Invalid("nonce", fmt.Sprintf("nonce must be %d bytes", DefaultNonceByteSize))
	}
	return nil
}

func DeviceIDFromRemoteID(remoteID string) (string, error) {
	normalized := strings.TrimSpace(remoteID)
	if normalized == "" {
		return "", Missing("remote_id")
	}
	const deviceScheme = "device://"
	if strings.Contains(normalized, "://") {
		if !strings.HasPrefix(normalized, deviceScheme) {
			return "", Invalid("remote_id", "remote_id must be a bare device id or device:// id")
		}
		normalized = strings.TrimSpace(strings.TrimPrefix(normalized, deviceScheme))
	}
	if normalized == "" {
		return "", Missing("remote_id")
	}
	return normalized, nil
}

func Sign(input SigningInput) (SignedToken, error) {
	if err := ValidateInput(input); err != nil {
		return SignedToken{}, err
	}
	deviceID, err := DeviceIDFromRemoteID(input.RemoteID)
	if err != nil {
		return SignedToken{}, err
	}
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	nonceBytes := input.NonceBytes
	if len(nonceBytes) == 0 {
		nonceBytes = make([]byte, DefaultNonceByteSize)
		if _, err := rand.Read(nonceBytes); err != nil {
			return SignedToken{}, Internal("failed to generate nonce")
		}
	}
	iat := now.Unix()
	claims := Claims{
		Subject: NormalizeSubject(input.Subject),
		Scope:   "connect:device://" + deviceID,
		Issuer:  input.AccessKeyID,
		Issued:  iat,
		Expires: iat + NormalizeTTL(input.TTLSeconds),
		Nonce:   base64.RawURLEncoding.EncodeToString(nonceBytes),
	}
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return SignedToken{}, Internal("failed to encode claims")
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)
	deviceSig := hmacBase64(input.DeviceSecretKey, payload)
	appSig := hmacBase64(input.SecretKeyID, payload+"."+deviceSig)
	return SignedToken{
		Token:  "v1." + payload + "." + appSig,
		Claims: claims,
	}, nil
}

func hmacBase64(key string, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(message))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func ReasonOf(err error) ReasonCode {
	var userErr *UserError
	if errors.As(err, &userErr) {
		return userErr.ReasonCode
	}
	return ReasonInternalError
}

func ExitCode(reason ReasonCode) int {
	switch reason {
	case ReasonMissingRequiredInput, ReasonInvalidRequest:
		return 2
	default:
		return 5
	}
}

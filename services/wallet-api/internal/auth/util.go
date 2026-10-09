package auth

import "encoding/base64"

func rawURLEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func rawURLDecode(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

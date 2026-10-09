package logging

import (
	"context"
	"log/slog"
	"os"
)

// New builds the process-wide structured logger. level "debug" is only
// intended for APP_ENV=development.
func New(level slog.Level) *slog.Logger {
	base := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	return slog.New(NewRedactingHandler(base))
}

type ctxKey struct{}

// WithRequestID attaches a request id to the context so handlers downstream
// can log it without threading it through every call explicitly.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

func RequestIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}

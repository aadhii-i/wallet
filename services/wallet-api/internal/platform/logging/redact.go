// Package logging provides a redacting slog.Handler for wallet-api. The
// backend must never log secret material (mnemonics, seeds, private keys,
// passwords, PINs, tokens, cookies, ...). This handler is the last line of
// defence: callers should not log those fields at all, but if they do, the
// handler drops or masks them.
package logging

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
)

// deniedKeyPattern matches attribute keys that must never appear in logs,
// case-insensitively. It intentionally matches on substrings ("private"
// catches "privateKey", "isPrivate", etc.) to fail closed.
var deniedKeyPattern = regexp.MustCompile(`(?i)(mnemonic|seed|phrase|private|secret|password|pin|share|token|authorization|cookie)`)

const bip39RunMinWords = 12

// RedactingHandler wraps a slog.Handler and:
//  1. drops any attribute (at any nesting level) whose key matches
//     deniedKeyPattern,
//  2. masks any run of 12 or more consecutive lowercase words that are all
//     valid BIP-39 English words, wherever they appear in a string value or
//     the log message (a last-resort defence against an accidentally logged
//     recovery phrase).
type RedactingHandler struct {
	next slog.Handler
}

func NewRedactingHandler(next slog.Handler) *RedactingHandler {
	return &RedactingHandler{next: next}
}

func (h *RedactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *RedactingHandler) Handle(ctx context.Context, r slog.Record) error {
	nr := slog.NewRecord(r.Time, r.Level, MaskBIP39Runs(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool {
		if red, ok := redactAttr(a); ok {
			nr.AddAttrs(red)
		}
		return true
	})
	return h.next.Handle(ctx, nr)
}

func (h *RedactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	kept := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		if red, ok := redactAttr(a); ok {
			kept = append(kept, red)
		}
	}
	return &RedactingHandler{next: h.next.WithAttrs(kept)}
}

func (h *RedactingHandler) WithGroup(name string) slog.Handler {
	return &RedactingHandler{next: h.next.WithGroup(name)}
}

// redactAttr returns the (possibly transformed) attribute and whether it
// should be kept at all.
func redactAttr(a slog.Attr) (slog.Attr, bool) {
	if a.Key != "" && deniedKeyPattern.MatchString(a.Key) {
		return slog.Attr{}, false
	}
	a.Value = a.Value.Resolve()
	switch a.Value.Kind() {
	case slog.KindString:
		a.Value = slog.StringValue(MaskBIP39Runs(a.Value.String()))
	case slog.KindGroup:
		orig := a.Value.Group()
		kept := make([]slog.Attr, 0, len(orig))
		for _, sub := range orig {
			if red, ok := redactAttr(sub); ok {
				kept = append(kept, red)
			}
		}
		a.Value = slog.GroupValue(kept...)
	}
	return a, true
}

// MaskBIP39Runs scans s for runs of bip39RunMinWords or more consecutive
// whitespace-separated lowercase alphabetic tokens that are all valid BIP-39
// words, and replaces each such run with "[REDACTED]".
func MaskBIP39Runs(s string) string {
	if s == "" {
		return s
	}
	fields := strings.Fields(s)
	if len(fields) < bip39RunMinWords {
		return s
	}
	// Track which field indices belong to a qualifying run.
	isWord := make([]bool, len(fields))
	for i, f := range fields {
		isWord[i] = IsBIP39Word(strings.ToLower(strings.Trim(f, ".,;:!?")))
	}
	var b strings.Builder
	i := 0
	for i < len(fields) {
		if !isWord[i] {
			b.WriteString(fields[i])
			if i != len(fields)-1 {
				b.WriteByte(' ')
			}
			i++
			continue
		}
		j := i
		for j < len(fields) && isWord[j] {
			j++
		}
		runLen := j - i
		if runLen >= bip39RunMinWords {
			b.WriteString("[REDACTED]")
			if j != len(fields) {
				b.WriteByte(' ')
			}
		} else {
			for k := i; k < j; k++ {
				b.WriteString(fields[k])
				if k != len(fields)-1 {
					b.WriteByte(' ')
				}
			}
		}
		i = j
	}
	return b.String()
}

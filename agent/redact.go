package main

import (
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// redactSecrets replaces each secret (Config.Secrets, longest first) in text.
func redactSecrets(text string, secrets []string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}

var (
	urlPattern        = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]+`)
	assignmentPattern = regexp.MustCompile(`(?i)\b(password|passwd|pwd|pass|secret|token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)`)
	bearerPattern     = regexp.MustCompile(`(?i)\bbearer\s+[^\s,;]+`)
	agentTokenPattern = regexp.MustCompile(`bkp_[A-Za-z0-9_-]{8,}`)
)

// maxMessage is the longest message /fail takes, in characters.
const maxMessage = 500

// failMessage turns an error into a message for the Backup app: without secrets,
// without anything that looks like a URL or a password, one line of at most
// 500 characters.
func failMessage(text string, secrets []string) string {
	text = redactSecrets(text, secrets)
	text = urlPattern.ReplaceAllString(text, "[url]")
	text = assignmentPattern.ReplaceAllString(text, "${1}${2}[redacted]")
	text = bearerPattern.ReplaceAllString(text, "Bearer [redacted]")
	text = agentTokenPattern.ReplaceAllString(text, "[redacted]")
	text = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == utf8.RuneError {
			return ' '
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) > maxMessage {
		runes := []rune(text)
		text = string(runes[:maxMessage-1]) + "…"
	}
	if text == "" {
		text = "The agent could not produce the backup."
	}
	return text
}

// newLogger writes structured logs (key=value) to w. Every message and value
// passes redactSecrets, so a secret that slips into an error stays out of
// the log.
func newLogger(w io.Writer, level slog.Level, secrets []string) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			switch {
			case a.Key == slog.TimeKey && len(groups) == 0 && a.Value.Kind() == slog.KindTime:
				return slog.String(slog.TimeKey, a.Value.Time().UTC().Format(time.RFC3339))
			case a.Value.Kind() == slog.KindString:
				return slog.String(a.Key, redactSecrets(a.Value.String(), secrets))
			case a.Value.Kind() == slog.KindAny:
				if err, ok := a.Value.Any().(error); ok {
					return slog.String(a.Key, redactSecrets(err.Error(), secrets))
				}
			}
			return a
		},
	}))
}

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Config is the agent's environment (README.md, "Settings").
type Config struct {
	URL         string // BACKUP_URL without a trailing slash; empty: idle
	Token       string // BACKUP_TOKEN
	DatabaseURL string // DATABASE_URL; empty: no database dump
	DataDir     string // BACKUP_DATA_DIR: every directory below it is a volume
	AppName     string
	AppImage    string
	AppSecrets  []string // APP_SECRETS: names of settings a restore needs that are not in the backup
	TmpDir      string   // BACKUP_TMP_DIR: where the dump waits until it is sent
	LogLevel    slog.Level
	Version     string // the agent's own version (APP_VERSION of the image)
}

// tokenPattern: what the Backup app shows once when an admin adds the source.
var tokenPattern = regexp.MustCompile(`^bkp_[A-Za-z0-9_-]{43}$`)

// secretNamePattern is one name in APP_SECRETS; the Backup app takes the
// same, and at most maxAppSecrets of them.
var secretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,99}$`)

const maxAppSecrets = 20

// LoadConfig reads the environment. getenv is os.Getenv outside tests. Its
// errors never contain BACKUP_TOKEN or DATABASE_URL.
func LoadConfig(getenv func(string) string) (Config, error) {
	c := Config{
		URL:         strings.TrimRight(strings.TrimSpace(getenv("BACKUP_URL")), "/"),
		Token:       getenv("BACKUP_TOKEN"),
		DatabaseURL: getenv("DATABASE_URL"),
		DataDir:     orDefault(getenv("BACKUP_DATA_DIR"), "/data"),
		AppName:     getenv("APP_NAME"),
		AppImage:    getenv("APP_IMAGE"),
		TmpDir:      orDefault(getenv("BACKUP_TMP_DIR"), "/tmp"),
		Version:     orDefault(getenv("APP_VERSION"), "development"),
	}
	switch strings.ToLower(orDefault(getenv("LOG_LEVEL"), "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		return c, errors.New("LOG_LEVEL must be debug, info, warn or error.")
	}
	if c.URL != "" {
		u, err := url.Parse(c.URL)
		switch {
		case err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "":
			return c, errors.New("BACKUP_URL must be the address of the Backup app, such as https://backup.example.org.")
		case u.User != nil:
			return c, errors.New("BACKUP_URL must not contain a user or password; the agent signs in with BACKUP_TOKEN.")
		case u.RawQuery != "" || u.Fragment != "":
			return c, errors.New("BACKUP_URL must not contain a query or fragment, such as ?a=b or #top.")
		}
		if c.Token == "" {
			return c, errors.New("Set BACKUP_TOKEN to the token that the Backup app showed when the app was added as a source.")
		}
		if !tokenPattern.MatchString(c.Token) {
			return c, errors.New("BACKUP_TOKEN is not a token of the Backup app: it starts with bkp_ and has 47 characters, without spaces or quotes.")
		}
	}
	if c.DatabaseURL != "" && !isPostgresURL(c.DatabaseURL) {
		return c, errDatabaseURL
	}
	for name, value := range map[string]string{"APP_NAME": c.AppName, "APP_IMAGE": c.AppImage} {
		if len(value) > 200 || strings.ContainsFunc(value, func(r rune) bool { return r < 32 || r == 127 }) {
			return c, fmt.Errorf("%s must be one line of at most 200 characters.", name)
		}
	}
	secrets, err := parseAppSecrets(getenv("APP_SECRETS"))
	if err != nil {
		return c, err
	}
	c.AppSecrets = secrets
	return c, nil
}

var errDatabaseURL = errors.New("DATABASE_URL must start with postgres:// or postgresql://.")

func isPostgresURL(databaseURL string) bool {
	return strings.HasPrefix(databaseURL, "postgres://") || strings.HasPrefix(databaseURL, "postgresql://")
}

// parseAppSecrets reads APP_SECRETS: names separated by commas, without
// spaces, empty entries and repeats. Its errors never show the value, which
// may hold a secret by mistake.
func parseAppSecrets(value string) ([]string, error) {
	names := []string{}
	for _, name := range strings.Split(value, ",") {
		name = strings.TrimSpace(name)
		switch {
		case name == "" || slices.Contains(names, name):
			continue
		case !secretNamePattern.MatchString(name):
			return []string{}, errors.New("APP_SECRETS must name the app's settings, separated by commas, such as ENCRYPTION_KEY,AUTH_SECRET: names only, never values. A name starts with a letter or _, then has letters, digits or _, at most 100 characters.")
		}
		names = append(names, name)
	}
	if len(names) > maxAppSecrets {
		return []string{}, fmt.Errorf("APP_SECRETS must name at most %d settings.", maxAppSecrets)
	}
	return names, nil
}

// Secrets are the values that never reach a log or the Backup app: the token, the
// database URL and its password, longest first.
func (c Config) Secrets() []string {
	var secrets []string
	add := func(s string) {
		if s != "" {
			secrets = append(secrets, s)
		}
	}
	add(c.Token)
	add(c.DatabaseURL)
	if c.DatabaseURL != "" {
		_, password := splitPassword(c.DatabaseURL)
		add(password)
		// The password as it is written in the URL, perhaps percent-encoded.
		if m := rawPasswordPattern.FindStringSubmatch(c.DatabaseURL); m != nil {
			add(m[1])
		}
	}
	sort.SliceStable(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return secrets
}

var rawPasswordPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://[^:@/?#]*:([^@/?#]+)@`)

// listVolumes names the directories directly below dir, sorted. A missing
// dir has none.
func listVolumes(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return []string{}, fmt.Errorf("BACKUP_DATA_DIR cannot be read: %w", err)
	}
	volumes := []string{}
	for _, entry := range entries { // os.ReadDir sorts by name
		if entry.IsDir() {
			volumes = append(volumes, entry.Name())
		}
	}
	return volumes, nil
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

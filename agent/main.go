// Backup Agent: a sidecar of a self-hosted app that runs with Docker
// Compose and PostgreSQL. It asks the Backup app over HTTPS for jobs and,
// for each, sends one tar archive of the app's database (pg_dump) and its
// volumes, in parts. dump-database writes only the database to stdout. It
// opens no port and restores nothing. See README.md.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

const usage = `Usage: backup-agent [command]
  (none)          ask the Backup app for jobs and run them
  check           check the settings, the volumes, pg_dump, the database and the Backup app
  dump-database   write a dump of DATABASE_URL to stdout (pg_dump, custom format)
  version         print the agent's version`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run runs a command until it is done or ctx ends (SIGTERM, SIGINT).
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	switch {
	case len(args) > 1:
		fmt.Fprintln(stderr, usage)
		return 2
	case command == "version":
		fmt.Fprintln(stdout, version())
		return 0
	case command == "-h", command == "--help", command == "help":
		fmt.Fprintln(stdout, usage)
		return 0
	case command == "dump-database":
		return dumpDatabase(ctx, getenv, "pg_dump", stdout, stderr)
	case command != "" && command != "check":
		fmt.Fprintln(stderr, usage)
		return 2
	}

	cfg, err := LoadConfig(getenv)
	if err != nil {
		log := newLogger(stderr, slog.LevelInfo, cfg.Secrets())
		if command == "check" {
			log.Error(err.Error())
			return 1
		}
		// The agent never exits on a wrong setting: a deploy that runs
		// docker compose up --wait fails when a service exits.
		log.Error(err.Error() + " The agent is idle and backs up nothing until the setting is fixed.")
		<-ctx.Done()
		return 0
	}
	log := newLogger(stderr, cfg.LogLevel, cfg.Secrets())
	agent := NewAgent(cfg, log)
	if command == "check" {
		return agent.Check(ctx, stdout)
	}
	return agent.Run(ctx)
}

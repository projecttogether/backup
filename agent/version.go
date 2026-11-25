package main

import "os"

// version is the commit the image was built from: the image build sets
// APP_VERSION (Dockerfile). Outside an image build it is "development".
func version() string { return orDefault(os.Getenv("APP_VERSION"), "development") }

// userAgent names the agent and its version in every request to the Backup app.
func userAgent(version string) string { return "backup-agent/" + version }

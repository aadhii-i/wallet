// Package migrations embeds the goose SQL migrations so the binary can run
// them on startup (MIGRATE_ON_START=true) without shipping separate SQL
// files.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS

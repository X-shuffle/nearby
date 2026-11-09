package web

import (
	"embed"
	"io/fs"
)

// Build the frontend before compiling the production binary.
//
//go:embed all:dist
var assets embed.FS

func Assets() fs.FS {
	sub, err := fs.Sub(assets, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}

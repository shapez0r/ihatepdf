// Package web embeds the browser UI (including the bundled pdf-lib and pdf.js
// libraries) into the ihatepdf binary so a single executable (or a
// FROM-scratch container) serves everything.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var static embed.FS

// Static returns the UI file system rooted at the static directory.
func Static() fs.FS {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}
	return sub
}

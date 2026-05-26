package main

import (
	"os"

	"github.com/tangeai/tirtc-developer-tools/token-issuer/issuer"
)

func main() {
	os.Exit(issuer.Run(os.Args[1:], os.Stdout, os.Stderr))
}

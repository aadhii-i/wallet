package logging

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed bip39_english.txt
var bip39Raw string

var bip39Words map[string]struct{}

func init() {
	words := strings.Split(strings.TrimSpace(bip39Raw), "\n")
	if len(words) != 2048 {
		panic(fmt.Sprintf("logging: embedded BIP-39 wordlist has %d words, want 2048", len(words)))
	}
	bip39Words = make(map[string]struct{}, len(words))
	for _, w := range words {
		w = strings.TrimSpace(w)
		if w == "" {
			continue
		}
		bip39Words[w] = struct{}{}
	}
	if len(bip39Words) != 2048 {
		panic(fmt.Sprintf("logging: embedded BIP-39 wordlist has %d unique words, want 2048", len(bip39Words)))
	}
}

// IsBIP39Word reports whether w (already lowercased) is in the BIP-39
// English wordlist.
func IsBIP39Word(w string) bool {
	_, ok := bip39Words[w]
	return ok
}

// BIP39WordCount returns the number of words in the embedded wordlist
// (exported for tests that want to assert it is exactly 2048).
func BIP39WordCount() int {
	return len(bip39Words)
}

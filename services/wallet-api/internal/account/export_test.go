package account

// BtcAddressFromPubKeyForTest exposes btcAddressFromPubKey for use in
// external (_test) package tests.  It must only be compiled during testing.
func BtcAddressFromPubKeyForTest(compressedPubKey []byte, addressType, network string) (string, error) {
	return btcAddressFromPubKey(compressedPubKey, addressType, network)
}

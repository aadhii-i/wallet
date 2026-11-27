package nativecustody

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"strconv"
	"strings"
)

type wireValue struct {
	number uint64
	body   []byte
}

func wireVarint(data *[]byte) (uint64, error) {
	value, n := binary.Uvarint(*data)
	if n <= 0 {
		return 0, invalid("invalid protobuf integer")
	}
	var canonical [10]byte
	size := binary.PutUvarint(canonical[:], value)
	if size != n || !bytes.Equal(canonical[:size], (*data)[:n]) {
		return 0, invalid("noncanonical protobuf integer")
	}
	*data = (*data)[n:]
	return value, nil
}

// Decode only the supported operation. Reject duplicate, unknown, alternate
// operation and signed-envelope fields rather than ignoring them.
func wireFields(data []byte, allowed map[int]int) (map[int]wireValue, error) {
	result := map[int]wireValue{}
	for len(data) > 0 {
		tag, err := wireVarint(&data)
		if err != nil {
			return nil, err
		}
		field, kind := int(tag>>3), int(tag&7)
		expected, ok := allowed[field]
		if !ok || expected != kind {
			return nil, invalid("unsupported native transaction field")
		}
		if _, duplicate := result[field]; duplicate {
			return nil, invalid("duplicate native transaction field")
		}
		value := wireValue{}
		if kind == 0 {
			value.number, err = wireVarint(&data)
		} else {
			var size uint64
			size, err = wireVarint(&data)
			if err == nil {
				if size > uint64(len(data)) {
					return nil, invalid("truncated native transaction")
				}
				value.body = data[:int(size)]
				data = data[int(size):]
			}
		}
		if err != nil {
			return nil, err
		}
		result[field] = value
	}
	return result, nil
}
func wireAccount(data []byte, expected string) bool {
	fields, err := wireFields(data, map[int]int{1: 0, 2: 0, 3: 0})
	if err != nil || fields[1].number != 0 || fields[2].number != 0 {
		return false
	}
	return expected == "0.0."+strconv.FormatUint(fields[3].number, 10)
}
func reviewedHedera(p nativeProposal, intent MigrationIntent, memo string) error {
	fail := invalid("Hedera frozen bytes differ from the reviewed key update")
	raw, err := base64.StdEncoding.DecodeString(p.TransactionBytes)
	if err != nil || len(raw) > 32768 {
		return fail
	}
	list, err := wireFields(raw, map[int]int{1: 2})
	if err != nil || len(list) != 1 {
		return fail
	}
	tx, err := wireFields(list[1].body, map[int]int{5: 2})
	if err != nil || len(tx) != 1 {
		return fail
	}
	signed, err := wireFields(tx[5].body, map[int]int{1: 2, 2: 2})
	if err != nil || len(signed[2].body) != 0 {
		return fail
	}
	body, err := wireFields(signed[1].body, map[int]int{1: 2, 2: 2, 3: 0, 4: 2, 5: 0, 6: 2, 15: 2})
	if err != nil || len(body) < 6 || body[5].number != 0 || string(body[6].body) != memo || !wireAccount(body[2].body, "0.0.3") {
		return fail
	}
	fee, err := strconv.ParseUint(p.MaxFee, 10, 64)
	if err != nil || fee != body[3].number {
		return fail
	}
	duration, err := wireFields(body[4].body, map[int]int{1: 0})
	if err != nil || duration[1].number != 120 {
		return fail
	}
	id, err := wireFields(body[1].body, map[int]int{1: 2, 2: 2, 3: 0, 4: 0})
	if err != nil || id[3].number != 0 || id[4].number != 0 || !wireAccount(id[2].body, intent.HederaAccountID) {
		return fail
	}
	stamp, err := wireFields(id[1].body, map[int]int{1: 0, 2: 0})
	if err != nil || stamp[1].number == 0 || stamp[1].number > 1<<53 || stamp[2].number >= 1000000000 {
		return fail
	}
	parts := strings.Split(p.TransactionID, "@")
	if len(parts) != 2 || parts[0] != intent.HederaAccountID {
		return fail
	}
	expected, err := nativeTimestamp(parts[1])
	if err != nil {
		return fail
	}
	actual, err := nativeTimestamp(strconv.FormatUint(stamp[1].number, 10) + "." + leftPad(strconv.FormatUint(stamp[2].number, 10), 9))
	if err != nil || actual.Cmp(expected) != 0 {
		return fail
	}
	if int64(stamp[1].number)*1000+int64(stamp[2].number/1000000)+120000 != p.ExpiresAt {
		return fail
	}
	update, err := wireFields(body[15].body, map[int]int{2: 2, 3: 2})
	if err != nil || len(update) != 2 || !wireAccount(update[2].body, intent.HederaAccountID) || hex.EncodeToString(update[3].body) != intent.TargetKey {
		return fail
	}
	return nil
}
func leftPad(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return strings.Repeat("0", width-len(value)) + value
}
